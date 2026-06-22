/**
 * DOUBLE-CLOSE RACE CONTRACT — main BrowserWindow `close` while a project
 * session is active (onClose in app.ts wireAppWindowEvents).
 *
 * Bug guarded against: the user rapidly double-clicks the window close button,
 * so the main window receives TWO `close` events.
 *
 *   - Close #1: handler calls `event.preventDefault()` (window stays open) and
 *     starts the async `closeProject()` teardown.
 *   - Key timing: `closeProject()` synchronously nulls the active session
 *     (real `disposeSession` sets `currentSession = null` BEFORE awaiting
 *     `session.close()`), so `workspace.hasActiveSession()` becomes false while
 *     teardown is still in-flight (the `await session.close()` hop).
 *   - Close #2 (arrives during that await window): the CURRENT bug is the
 *     handler sees `hasActiveSession() === false`, returns early, and crucially
 *     never calls `event.preventDefault()`. The window is then destroyed →
 *     last window closed → `window-all-closed` → `app.quit()` → the whole app
 *     exits, when all the user wanted was to close one project.
 *
 * Contract (RED until fixed): BOTH close events must be preventDefault'd; the
 * second close arriving mid-teardown must NOT let the window be destroyed and
 * must NOT cause `app.quit()`.
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
    show = vi.fn()
    showInactive = vi.fn()
    focus = vi.fn()
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
import { WindowChannel } from '../../shared/ipc-channels.js'
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

async function openProject(dir: string) {
  stubs.projectsWithAppJson.add(dir)
  stubs.setProjectsJson(JSON.stringify([]))
  const instance = await createDevtoolsRuntime({})
  const openResult = await instance.context.workspace.openProject(dir)
  expect(openResult.success).toBe(true)
  expect(instance.context.workspace.hasActiveSession()).toBe(true)
  return instance
}

function emitClose(instance: Awaited<ReturnType<typeof createDevtoolsRuntime>>, fakeEvent: unknown) {
  ;(instance.mainWindow as unknown as {
    emit: (event: string, ...args: unknown[]) => void
  }).emit('close', fakeEvent)
}

describe('double-close race: second close arriving during project teardown', () => {
  it('preventDefaults BOTH close events even though hasActiveSession() flips false mid-teardown', async () => {
    const instance = await openProject('/tmp/projDoubleClose')

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
    emitClose(instance, first.event)

    // First close must have preventDefault'd AND driven closeProject far enough
    // that the active session is already gone (real disposeSession nulls it
    // before awaiting close), yet the teardown is still in-flight.
    await vi.waitFor(
      () => {
        expect(instance.context.workspace.hasActiveSession()).toBe(false)
        expect(devkitStubs.sessionClose).toHaveBeenCalledTimes(1)
      },
      { timeout: 2000 },
    )
    expect(first.prevented, 'first close must preventDefault to keep the window').toBe(1)

    // Second close arrives DURING the parked teardown — this is the race.
    const second = makeCloseEvent()
    emitClose(instance, second.event)

    // The regression: handler sees hasActiveSession()===false and returns
    // early WITHOUT preventDefault, so the window is destroyed and the app
    // quits. The fix must keep the window alive → preventDefault here too.
    expect(
      second.prevented,
      'a second close while teardown is in-flight MUST also preventDefault — otherwise the '
      + 'window is destroyed → window-all-closed → app.quit() and the whole app exits',
    ).toBe(1)

    // Let the parked teardown finish so dispose() is clean.
    resolveClose?.()
    await vi.waitFor(() => {
      expect(devkitStubs.sessionClose).toHaveBeenCalledTimes(1)
    })

    await instance.dispose()
  })

  it('the second close does NOT destroy the window nor quit the app', async () => {
    const instance = await openProject('/tmp/projDoubleCloseNoQuit')

    let resolveClose: (() => void) | undefined
    devkitStubs.sessionClose.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve
        }),
    )

    const first = makeCloseEvent()
    emitClose(instance, first.event)
    await vi.waitFor(
      () => {
        expect(instance.context.workspace.hasActiveSession()).toBe(false)
      },
      { timeout: 2000 },
    )

    const destroySpy = vi.mocked(instance.mainWindow.destroy)
    const quitSpy = vi.mocked(electron.app.quit)
    destroySpy.mockClear()
    quitSpy.mockClear()

    const second = makeCloseEvent()
    emitClose(instance, second.event)

    // Give the close handler a chance to run.
    await new Promise((r) => setTimeout(r, 50))

    // In real Electron, a `close` event that is NOT preventDefault'd destroys
    // the window → window-all-closed → app.quit(). The JS mock cannot simulate
    // that native destroy, so the only observable proxy for "the window
    // survives" is that the handler preventDefault'd this second close. The
    // bug leaves it un-prevented (early return on hasActiveSession()===false),
    // which in production is precisely what lets the window be destroyed and
    // the app quit.
    expect(
      second.prevented,
      'the second close during teardown must be preventDefault\'d — un-prevented, real Electron '
      + 'destroys the window → window-all-closed → app.quit()',
    ).toBe(1)
    expect(
      instance.mainWindow.isDestroyed(),
      'the main window must survive the second close during teardown',
    ).toBe(false)
    expect(
      destroySpy,
      'the second close must not destroy the main window mid-teardown',
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

describe('double-close: existing single-close / no-session contracts still hold', () => {
  it('a normal single close with an active session: preventDefault once + closeProject + navigateBack', async () => {
    const instance = await openProject('/tmp/projSingleClose')

    const sendSpy = vi.mocked(instance.mainWindow.webContents.send)
    sendSpy.mockClear()

    const evt = makeCloseEvent()
    emitClose(instance, evt.event)

    await vi.waitFor(
      () => {
        expect(instance.context.workspace.hasActiveSession()).toBe(false)
        const calls = sendSpy.mock.calls.filter(
          (c) => c[0] === WindowChannel.NavigateBack,
        )
        expect(calls.length).toBeGreaterThanOrEqual(1)
      },
      { timeout: 2000 },
    )

    expect(evt.prevented, 'a plain close-while-open stays in the workbench').toBe(1)
    expect(devkitStubs.sessionClose).toHaveBeenCalledTimes(1)

    await instance.dispose()
  })

  it('a close with NO active session is allowed through (no preventDefault) so the app can quit', async () => {
    // Open then close so we are in the no-project state, mirroring "user closed
    // the project, now clicks close again to exit the app".
    const instance = await openProject('/tmp/projNoSession')
    await instance.context.workspace.closeProject()
    expect(instance.context.workspace.hasActiveSession()).toBe(false)

    const evt = makeCloseEvent()
    emitClose(instance, evt.event)

    await new Promise((r) => setTimeout(r, 50))

    expect(
      evt.prevented,
      'with no active session the close must pass through so quitting the app works',
    ).toBe(0)

    await instance.dispose()
  })
})
