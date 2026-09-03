/**
 * DOUBLE-CLOSE RACE CONTRACT — a workbench window's `close` while its project
 * session is active (the in-flight guard in workbench-window.ts).
 *
 * Bug guarded against: the user rapidly double-clicks the window close button,
 * so the window receives TWO `close` events.
 *
 *   - Close #1: handler calls `event.preventDefault()` (the window stays until
 *     teardown finishes) and starts the async `closeProject()` teardown.
 *   - Key timing: `closeProject()` synchronously nulls the active session
 *     (real `disposeSession` sets `currentSession = null` BEFORE awaiting
 *     `session.close()`), so `workspace.hasActiveSession()` becomes false while
 *     teardown is still in-flight (the `await session.close()` hop).
 *   - Close #2 (arrives during that await window): a handler keyed off session
 *     presence sees `hasActiveSession() === false`, returns early, and
 *     crucially never calls `event.preventDefault()`. Chromium then destroys
 *     the window out from under a live teardown — and back when this was the
 *     only window, `window-all-closed` → `app.quit()` took the whole app with
 *     it, when all the user wanted was to close one project.
 *
 * Contract: BOTH close events must be preventDefault'd; the second close
 * arriving mid-teardown must NOT let the window be destroyed and must NOT
 * cause `app.quit()`. The window is destroyed exactly once, by the close
 * handler itself, after teardown resolves.
 *
 * Timing reproduction: we replace the devkit session `close()` with a deferred
 * promise that stays pending under test control. That keeps `closeProject()`
 * parked at `await session.close()` — exactly the window during which the
 * second close arrives — while `hasActiveSession()` has ALREADY flipped false.
 *
 * Harness (electron + fs + devkit mocks, real createDevtoolsRuntime) lifted
 * from `close-with-active-session.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Hoisted stub state ──────────────────────────────────────────────────
const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  const handlers = new Map<string, AnyFn>()
  const projectsJsonPath = '/tmp/dimina-test-userdata/dimina-projects.json'
  let projectsJsonContent: string | null = null
  const projectsWithAppJson = new Set<string>()

  function makeEmitter() {
    const listeners: EventBag = {}
    return {
      listeners,
      on(event: string, fn: AnyFn) {
        ;(listeners[event] ??= new Set()).add(fn)
        return this
      },
      once(event: string, fn: AnyFn) {
        const wrap: AnyFn = (...args: unknown[]) => {
          listeners[event]?.delete(wrap)
          return fn(...args)
        }
        ;(listeners[event] ??= new Set()).add(wrap)
        return this
      },
      off(event: string, fn: AnyFn) {
        listeners[event]?.delete(fn)
        return this
      },
      removeListener(event: string, fn: AnyFn) {
        listeners[event]?.delete(fn)
        return this
      },
      emit(event: string, ...args: unknown[]) {
        for (const fn of [...(listeners[event] ?? [])]) fn(...args)
      },
    }
  }

  function reset() {
    handlers.clear()
    projectsJsonContent = null
    projectsWithAppJson.clear()
  }

  return {
    handlers,
    projectsJsonPath,
    getProjectsJson() {
      return projectsJsonContent
    },
    setProjectsJson(v: string | null) {
      projectsJsonContent = v
    },
    projectsWithAppJson,
    makeEmitter,
    reset,
  }
})

// ── electron stub ────────────────────────────────────────────────────────
// `app` is a live emitter so `registerAppLifecycle` can wire `window-all-closed`
// → `app.quit()`. The BrowserWindow records `destroy()` so we can assert the
// window survives a double close.
vi.mock('electron', () => {
  type AnyFn = (...args: unknown[]) => unknown

  const ipcEmitter = stubs.makeEmitter()
  const ipcMain = {
    ...ipcEmitter,
    handle: vi.fn((channel: string, fn: AnyFn) => {
      stubs.handlers.set(channel, fn)
    }),
    removeHandler: vi.fn((channel: string) => {
      stubs.handlers.delete(channel)
    }),
    on: vi.fn((event: string, fn: AnyFn) => ipcEmitter.on(event, fn)),
    removeListener: vi.fn((event: string, fn: AnyFn) =>
      ipcEmitter.removeListener(event, fn),
    ),
  }

  const appEmitter = stubs.makeEmitter()
  const app = {
    ...appEmitter,
    isPackaged: true,
    whenReady: vi.fn(() => Promise.resolve()),
    getPath: vi.fn(() => '/tmp/dimina-test-userdata'),
    quit: vi.fn(),
    setName: vi.fn(),
    commandLine: {
      getSwitchValue: vi.fn(() => ''),
      appendSwitch: vi.fn(),
    },
  }

  class WebContents {
    private em = stubs.makeEmitter()
    destroyed = false
    id = Math.floor(Math.random() * 1e6)
    on = this.em.on.bind(this.em)
    once = this.em.once.bind(this.em)
    off = this.em.off.bind(this.em)
    removeListener = this.em.removeListener.bind(this.em)
    emit = this.em.emit.bind(this.em)
    send = vi.fn()
    isDestroyed = () => this.destroyed
    openDevTools = vi.fn()
    closeDevTools = vi.fn()
    setDevToolsWebContents = vi.fn()
    setWindowOpenHandler = vi.fn()
    loadFile = vi.fn(() => Promise.resolve())
    loadURL = vi.fn(() => Promise.resolve())
    executeJavaScript = vi.fn(() => Promise.resolve(undefined))
    reload = vi.fn()
    getType = () => 'window'
    getURL = () => ''
    debugger = {
      attach: vi.fn(),
      detach: vi.fn(),
      isAttached: () => false,
      on: vi.fn(),
      removeListener: vi.fn(),
      sendCommand: vi.fn(() => Promise.resolve({ entries: [] })),
    }
    close = vi.fn(() => {
      this.destroyed = true
    })
  }

  class WebContentsView {
    webContents = new WebContents()
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
  }

  class View {
    children: View[] = []
    addChildView(child: View) {
      this.children.push(child)
    }
    removeChildView(child: View) {
      const i = this.children.indexOf(child)
      if (i >= 0) this.children.splice(i, 1)
    }
  }

  class BrowserWindow {
    private em = stubs.makeEmitter()
    destroyed = false
    visible = true
    minimized = false
    webContents = new WebContents()
    contentView: View | WebContentsView = new WebContentsView()
    on = this.em.on.bind(this.em)
    once = this.em.once.bind(this.em)
    off = this.em.off.bind(this.em)
    removeListener = this.em.removeListener.bind(this.em)
    emit = this.em.emit.bind(this.em)
    isDestroyed = () => this.destroyed
    getContentSize = () => [1280, 980]
    setIcon = vi.fn()
    setTitle = vi.fn()
    show = vi.fn(() => { this.visible = true })
    showInactive = vi.fn()
    focus = vi.fn()
    hide = vi.fn(() => { this.visible = false })
    isVisible = () => this.visible
    minimize = vi.fn(() => { this.minimized = true })
    isMinimized = () => this.minimized
    restore = vi.fn(() => { this.minimized = false })
    close = vi.fn()
    destroy = vi.fn(() => {
      this.destroyed = true
    })
    loadFile = vi.fn(() => Promise.resolve())
    loadURL = vi.fn(() => Promise.resolve())
    static getAllWindows = vi.fn(() => [] as BrowserWindow[])
  }

  const sessionStub = {
    fromPartition: vi.fn(() => ({
      webRequest: {
        onBeforeSendHeaders: vi.fn(),
        onHeadersReceived: vi.fn(),
      },
      registerPreloadScript: vi.fn(),
      protocol: { handle: vi.fn(), unhandle: vi.fn() },
    })),
    defaultSession: {
      protocol: { handle: vi.fn(), unhandle: vi.fn() },
      registerPreloadScript: vi.fn(() => 'stub-preload-script-id'),
      unregisterPreloadScript: vi.fn(),
    },
  }

  const dialog = {
    showOpenDialog: vi.fn(() =>
      Promise.resolve({ canceled: true, filePaths: [] }),
    ),
    showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
  }

  const Menu = {
    buildFromTemplate: vi.fn((tpl: unknown) => ({ template: tpl })),
    setApplicationMenu: vi.fn(),
  }

  const shell = {
    openExternal: vi.fn(() => Promise.resolve()),
    openPath: vi.fn(() => Promise.resolve('')),
  }

  const nativeImage = {
    createFromPath: vi.fn(() => ({ isEmpty: () => true })),
  }

  const nativeTheme = { ...stubs.makeEmitter(), themeSource: 'system' }

  const globalShortcut = {
    register: vi.fn(() => false),
    unregister: vi.fn(),
    unregisterAll: vi.fn(),
  }

  const webContentsStatic = {
    fromId: vi.fn(() => null),
    getAllWebContents: vi.fn(() => [] as WebContents[]),
  }

  const Tray = vi.fn()

  return {
    app,
    ipcMain,
    BrowserWindow,
    WebContentsView,
    BrowserView: WebContentsView,
    View,
    webContents: webContentsStatic,
    session: sessionStub,
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn(), unhandle: vi.fn() },
    dialog,
    Menu,
    shell,
    nativeImage,
    nativeTheme,
    globalShortcut,
    Tray,
    default: {},
  }
})

vi.mock('fs', async () => {
  const real = await vi.importActual<typeof import('fs')>('fs')

  function existsSync(p: import('fs').PathLike): boolean {
    const s = String(p)
    if (s === stubs.projectsJsonPath) return stubs.getProjectsJson() !== null
    if (s.endsWith('/app.json') || s.endsWith('\\app.json')) {
      const dir = s.replace(/[\\/]app\.json$/, '')
      return stubs.projectsWithAppJson.has(dir)
    }
    return true
  }

  function readFileSync(p: import('fs').PathOrFileDescriptor, opts?: unknown): string {
    const s = String(p)
    if (s === stubs.projectsJsonPath) {
      const content = stubs.getProjectsJson()
      if (content === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return content
    }
    return (real.readFileSync as (...a: unknown[]) => string)(p as never, opts as never)
  }

  function writeFileSync(p: import('fs').PathOrFileDescriptor, data: string | Buffer | Uint8Array): void {
    const s = String(p)
    if (s === stubs.projectsJsonPath) {
      stubs.setProjectsJson(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
    }
  }

  const mocked = {
    ...real,
    existsSync,
    readFileSync,
    writeFileSync,
    mkdirSync: vi.fn(),
    statSync: vi.fn(() => ({ isDirectory: () => true, isFile: () => false, size: 0, mtimeMs: 0 } as unknown as import('fs').Stats)),
    watch: vi.fn(),
    realpathSync: vi.fn((p: string) => p),
  }
  return { ...mocked, default: mocked }
})

// The devkit session `close()` is a hoisted spy so each test can swap in its
// own implementation — notably a DEFERRED promise to park `closeProject()`
// mid-teardown while we fire a second close event.
const devkitStubs = vi.hoisted(() => ({
  sessionClose: vi.fn(() => Promise.resolve()),
}))

vi.mock('@dimina-kit/devkit', () => ({
  openProject: vi.fn(() =>
    Promise.resolve({
      port: 12345,
      appInfo: { appId: 'fakeApp' },
      close: devkitStubs.sessionClose,
    }),
  ),
}))

// ── Lazy imports ────────────────────────────────────────────────────────
let createDevtoolsRuntime: typeof import('./app.js').createDevtoolsRuntime
let electron: typeof import('electron')

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  devkitStubs.sessionClose.mockReset()
  devkitStubs.sessionClose.mockImplementation(() => Promise.resolve())
  electron = await import('electron')
  ;({ createDevtoolsRuntime } = await import('./app.js'))
})

type Instance = Awaited<ReturnType<typeof createDevtoolsRuntime>>
type ProjectWindow = ReturnType<Instance['projectWindows']>[number]

/** A close event that records how many times preventDefault was called. */
function makeCloseEvent() {
  let prevented = 0
  return {
    event: { preventDefault: () => { prevented += 1 } },
    get prevented() {
      return prevented
    },
  }
}

/**
 * Boots the app, opens `dir` in its own workbench window and establishes a live
 * session behind it — the state a close has to tear down.
 */
async function openProject(dir: string): Promise<{ instance: Instance; projectWindow: ProjectWindow }> {
  stubs.projectsWithAppJson.add(dir)
  stubs.setProjectsJson(JSON.stringify([]))
  const instance = await createDevtoolsRuntime({})
  await instance.openProjectWindow({ path: dir })
  const [projectWindow] = instance.projectWindows()
  expect(projectWindow, 'openProjectWindow must publish the window it opened').toBeTruthy()
  const openResult = await projectWindow!.context.workspace.openProject(dir)
  expect(openResult.success).toBe(true)
  expect(projectWindow!.context.workspace.hasActiveSession()).toBe(true)
  return { instance, projectWindow: projectWindow! }
}

function emitClose(win: unknown, fakeEvent: unknown) {
  ;(win as { emit: (event: string, ...args: unknown[]) => void }).emit('close', fakeEvent)
}

describe('double-close race: second close arriving during project teardown', () => {
  it('preventDefaults BOTH close events even though hasActiveSession() flips false mid-teardown', async () => {
    const { instance, projectWindow } = await openProject('/tmp/projDoubleClose')

    // Teardown must run exactly once however many closes arrive: a re-entrant
    // close is swallowed, never started as a second teardown of the same
    // project (which would close an already-closed session and dispose the
    // window's registry twice).
    const closeProjectSpy = vi.spyOn(projectWindow.context.workspace, 'closeProject')

    // Park the teardown: closeProject() will null the session synchronously,
    // then await session.close() — which now never resolves until we say so.
    let resolveClose: (() => void) | undefined
    devkitStubs.sessionClose.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve
        }),
    )

    const first = makeCloseEvent()
    emitClose(projectWindow.window, first.event)

    // First close must have preventDefault'd AND driven closeProject far enough
    // that the active session is already gone (real disposeSession nulls it
    // before awaiting close), yet the teardown is still in-flight.
    await vi.waitFor(
      () => {
        expect(projectWindow.context.workspace.hasActiveSession()).toBe(false)
        expect(devkitStubs.sessionClose).toHaveBeenCalledTimes(1)
      },
      { timeout: 2000 },
    )
    expect(first.prevented, 'first close must preventDefault so teardown can finish').toBe(1)

    // Second close arrives DURING the parked teardown — this is the race.
    const second = makeCloseEvent()
    emitClose(projectWindow.window, second.event)

    // The regression: handler sees hasActiveSession()===false and returns
    // early WITHOUT preventDefault, so Chromium destroys the window while its
    // teardown is still running. The fix must hold the window → preventDefault
    // here too.
    expect(
      second.prevented,
      'a second close while teardown is in-flight MUST also preventDefault — otherwise Chromium '
      + 'destroys the window out from under a live teardown',
    ).toBe(1)

    // Drain a macrotask so a (wrongly) re-entered teardown would have started.
    await new Promise((r) => setTimeout(r, 0))
    expect(
      closeProjectSpy,
      'the re-entrant close must be swallowed — running teardown twice tears the same project '
      + 'down while its first teardown is still in flight',
    ).toHaveBeenCalledTimes(1)

    // Let the parked teardown finish so dispose() is clean.
    resolveClose?.()
    await vi.waitFor(() => {
      expect(devkitStubs.sessionClose).toHaveBeenCalledTimes(1)
    })

    await instance.dispose()
  })

  it('the second close does NOT destroy the window nor quit the app', async () => {
    const { instance, projectWindow } = await openProject('/tmp/projDoubleCloseNoQuit')

    let resolveClose: (() => void) | undefined
    devkitStubs.sessionClose.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve
        }),
    )

    const first = makeCloseEvent()
    emitClose(projectWindow.window, first.event)
    await vi.waitFor(
      () => {
        expect(projectWindow.context.workspace.hasActiveSession()).toBe(false)
      },
      { timeout: 2000 },
    )

    const destroySpy = vi.mocked(projectWindow.window.destroy)
    const listDestroySpy = vi.mocked(instance.mainWindow.destroy)
    const quitSpy = vi.mocked(electron.app.quit)
    destroySpy.mockClear()
    listDestroySpy.mockClear()
    quitSpy.mockClear()

    const second = makeCloseEvent()
    emitClose(projectWindow.window, second.event)

    // Drain a macrotask so the async close handler runs.
    await new Promise((r) => setTimeout(r, 0))

    // In real Electron, a `close` event that is NOT preventDefault'd destroys
    // the window immediately. The JS mock cannot simulate that native destroy,
    // so the observable proxies for "the window survives its own teardown" are
    // that the handler preventDefault'd this second close and that nothing
    // destroyed the window while `session.close()` is still parked.
    expect(
      second.prevented,
      'the second close during teardown must be preventDefault\'d — un-prevented, real Electron '
      + 'destroys the window mid-teardown',
    ).toBe(1)
    expect(
      projectWindow.window.isDestroyed(),
      'the workbench window must survive until its own teardown finishes',
    ).toBe(false)
    expect(
      destroySpy,
      'the second close must not destroy the window mid-teardown',
    ).not.toHaveBeenCalled()
    expect(
      listDestroySpy,
      'closing one project must never take the project list window down',
    ).not.toHaveBeenCalled()
    expect(
      quitSpy,
      'a project-close double click must never quit the whole app',
    ).not.toHaveBeenCalled()

    resolveClose?.()
    await vi.waitFor(() => {
      expect(devkitStubs.sessionClose).toHaveBeenCalledTimes(1)
    })

    await instance.dispose()
  })
})

describe('double-close: the single-close and no-session contracts still hold', () => {
  it('a normal single close with an active session: preventDefault once + closeProject + the window is destroyed once', async () => {
    const { instance, projectWindow } = await openProject('/tmp/projSingleClose')

    const destroySpy = vi.mocked(projectWindow.window.destroy)
    destroySpy.mockClear()

    const evt = makeCloseEvent()
    emitClose(projectWindow.window, evt.event)

    await vi.waitFor(
      () => {
        expect(projectWindow.context.workspace.hasActiveSession()).toBe(false)
        expect(destroySpy).toHaveBeenCalledTimes(1)
      },
      { timeout: 2000 },
    )

    expect(evt.prevented, 'the close is held back exactly once, until teardown finishes').toBe(1)
    expect(devkitStubs.sessionClose).toHaveBeenCalledTimes(1)

    await instance.dispose()
  })

  it('a workbench window with NO active session is still torn down, while the list window\'s close passes through', async () => {
    // Close the project first, so the window is in the no-session state that a
    // session-gated handler would skip teardown for.
    const { instance, projectWindow } = await openProject('/tmp/projNoSession')
    await projectWindow.context.workspace.closeProject()
    expect(projectWindow.context.workspace.hasActiveSession()).toBe(false)

    const destroySpy = vi.mocked(projectWindow.window.destroy)
    destroySpy.mockClear()

    const workbenchEvt = makeCloseEvent()
    emitClose(projectWindow.window, workbenchEvt.event)

    await vi.waitFor(() => {
      expect(destroySpy).toHaveBeenCalledTimes(1)
    }, { timeout: 2000 })
    expect(
      workbenchEvt.prevented,
      'teardown is unconditional: a session-less workbench window still owns views, an editor '
      + 'server and IPC registrations, so its close is held back until they are released',
    ).toBe(1)

    // "Now close the app": that is the list window, which owns no project.
    const listEvt = makeCloseEvent()
    emitClose(instance.mainWindow, listEvt.event)
    await new Promise((r) => setTimeout(r, 0))

    expect(
      listEvt.prevented,
      'the list window close must pass through so quitting the app works',
    ).toBe(0)

    await instance.dispose()
  })
})
