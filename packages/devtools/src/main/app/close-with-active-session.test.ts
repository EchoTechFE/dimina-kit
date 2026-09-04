/**
 * Behavior tests for a workbench window's `close` event while its project
 * session is active.
 *
 * Contract under test:
 *  - `event.preventDefault()` is called, so teardown finishes before the
 *    window goes away.
 *  - The project session is torn down — `workspace.hasActiveSession()` is
 *    false afterwards.
 *  - That one window is destroyed; the project-list window and the
 *    application survive.
 *  - Every IPC handler the application and the list window were serving
 *    beforehand is STILL registered afterwards. The regression we guard
 *    against: a previous implementation disposed the whole IPC registry on
 *    close, leaving a live renderer with no handlers behind it (the Import
 *    button silently broke).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Hoisted stub state ──────────────────────────────────────────────────
const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  /** Channel → live handler fn (so we can invoke handlers from tests). */
  const handlers = new Map<string, AnyFn>()
  const handleCalls: string[] = []
  const removeHandlerCalls: string[] = []
  const onCalls: string[] = []
  const removeListenerCalls: string[] = []

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
    handleCalls.length = 0
    removeHandlerCalls.length = 0
    onCalls.length = 0
    removeListenerCalls.length = 0
    projectsJsonContent = null
    projectsWithAppJson.clear()
  }

  return {
    handlers,
    handleCalls,
    removeHandlerCalls,
    onCalls,
    removeListenerCalls,
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
vi.mock('electron', () => {
  type AnyFn = (...args: unknown[]) => unknown

  const ipcEmitter = stubs.makeEmitter()
  const ipcMain = {
    ...ipcEmitter,
    handle: vi.fn((channel: string, fn: AnyFn) => {
      if (stubs.handlers.has(channel)) {
        throw new Error(
          `Attempted to register a second handler for '${channel}'`,
        )
      }
      stubs.handlers.set(channel, fn)
      stubs.handleCalls.push(channel)
    }),
    removeHandler: vi.fn((channel: string) => {
      stubs.handlers.delete(channel)
      stubs.removeHandlerCalls.push(channel)
    }),
    on: vi.fn((event: string, fn: AnyFn) => {
      stubs.onCalls.push(event)
      ipcEmitter.on(event, fn)
    }),
    removeListener: vi.fn((event: string, fn: AnyFn) => {
      stubs.removeListenerCalls.push(event)
      ipcEmitter.removeListener(event, fn)
    }),
  }

  const appEmitter = stubs.makeEmitter()
  const app = {
    ...appEmitter,
    isPackaged: true,
    whenReady: vi.fn(() => Promise.resolve()),
    getPath: vi.fn(() => '/tmp/dimina-test-userdata'),
    quit: vi.fn(),
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
    // defaultSession stub — consumed by `registerEditorProtocolHandler`
    // (dmieditor:// scheme handler) during workbench setup.
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

  // `...makeEmitter()` so `syncWindowThemeBackground` can attach a
  // `nativeTheme.on('updated', …)` listener during window creation.
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
    if (s === stubs.projectsJsonPath) {
      return stubs.getProjectsJson() !== null
    }
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
      return
    }
  }

  function mkdirSync(): void {
    // no-op
  }

  function statSync(): import('fs').Stats {
    return {
      isDirectory: () => true,
      isFile: () => false,
      size: 0,
      mtimeMs: 0,
    } as unknown as import('fs').Stats
  }

  const mocked = {
    ...real,
    existsSync,
    readFileSync,
    writeFileSync,
    mkdirSync,
    statSync,
    watch: vi.fn(),
    realpathSync: vi.fn((p: string) => p),
  }
  return {
    ...mocked,
    default: mocked,
  }
})

// Default-adapter returns a fake session immediately, so workspace.openProject
// can establish an active session without spinning up a real compiler.
//
// MODIFYING THIS MOCK (leak-proofing wave): `close` was an anonymous
// `() => Promise.resolve()` — unobservable. It is now a hoisted spy so the
// app-teardown tests below can assert the session (and with it the devkit
// compile worker) is actually closed. Existing tests are unaffected: the
// session shape and resolution behavior are identical.
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
import { ProjectsChannel } from '../../shared/ipc-channels.js'
let createDevtoolsRuntime: typeof import('./app.js').createDevtoolsRuntime

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  devkitStubs.sessionClose.mockClear()
  ;({ createDevtoolsRuntime } = await import('./app.js'))
})

type Instance = Awaited<ReturnType<typeof createDevtoolsRuntime>>
type ProjectWindow = ReturnType<Instance['projectWindows']>[number]

/** Opens `dir` in its own workbench window and returns that window's record. */
async function openWorkbenchWindow(instance: Instance, dir: string): Promise<ProjectWindow> {
  await instance.openProjectWindow({ path: dir })
  const [projectWindow] = instance.projectWindows()
  expect(projectWindow, 'openProjectWindow must publish the window it opened').toBeTruthy()
  return projectWindow!
}

function emitClose(win: unknown, fakeEvent: unknown) {
  ;(win as { emit: (event: string, ...args: unknown[]) => void }).emit('close', fakeEvent)
}

describe('workbench window close while its project session is active', () => {
  it('calls event.preventDefault, tears down the session, and destroys that window only', async () => {
    const projectDir = '/tmp/projActive'
    stubs.projectsWithAppJson.add(projectDir)
    stubs.setProjectsJson(JSON.stringify([]))

    const instance = await createDevtoolsRuntime({})
    const projectWindow = await openWorkbenchWindow(instance, projectDir)

    // Open the project directly through the window's workspace service.
    // Bypasses the IPC layer because what we want to set up is "a session
    // exists behind this window".
    const openResult = await projectWindow.context.workspace.openProject(projectDir)
    expect(openResult.success).toBe(true)
    expect(projectWindow.context.workspace.hasActiveSession()).toBe(true)

    const destroySpy = vi.mocked(projectWindow.window.destroy)
    const listDestroySpy = vi.mocked(instance.mainWindow.destroy)
    destroySpy.mockClear()
    listDestroySpy.mockClear()

    // Build a fake close event that records preventDefault calls.
    let prevented = 0
    const fakeEvent = {
      preventDefault: () => {
        prevented += 1
      },
    }

    // Fire the close event the same way Electron would.
    emitClose(projectWindow.window, fakeEvent)

    // The close handler is fire-and-forget (returns void); wait for the
    // full sequence (session teardown, then the window going away) to settle.
    await vi.waitFor(
      () => {
        expect(projectWindow.context.workspace.hasActiveSession()).toBe(false)
        expect(destroySpy).toHaveBeenCalledTimes(1)
      },
      { timeout: 2000 },
    )

    expect(prevented).toBe(1)
    expect(
      listDestroySpy,
      'closing one project must not take the project list down with it',
    ).not.toHaveBeenCalled()
    expect(instance.mainWindow.isDestroyed()).toBe(false)

    await instance.dispose()
  })

  it('does NOT unregister the app-level IPC handlers — every channel the list window was served by is still active afterwards', async () => {
    const projectDir = '/tmp/projActiveKeepHandlers'
    stubs.projectsWithAppJson.add(projectDir)
    stubs.setProjectsJson(JSON.stringify([]))

    const instance = await createDevtoolsRuntime({})

    // Snapshot the live handler set BEFORE any workbench window exists: this
    // is exactly the surface the application and the project-list window own,
    // and all of it must outlive a workbench window's close. We include the
    // critical channels by name explicitly so a regression that drops *only
    // one* still fails this test.
    const liveBefore = new Set(stubs.handlers.keys())
    const criticalChannels = [
      ProjectsChannel.List,
      ProjectsChannel.Add,
      'dialog:openDirectory',
    ]
    for (const ch of criticalChannels) {
      expect(
        liveBefore.has(ch),
        `precondition: channel '${ch}' should be registered before close`,
      ).toBe(true)
    }

    const projectWindow = await openWorkbenchWindow(instance, projectDir)
    await projectWindow.context.workspace.openProject(projectDir)
    expect(projectWindow.context.workspace.hasActiveSession()).toBe(true)

    const removeHandlerCallsBefore = stubs.removeHandlerCalls.length
    const destroySpy = vi.mocked(projectWindow.window.destroy)
    destroySpy.mockClear()

    // Fire the close event.
    const fakeEvent = { preventDefault: () => {} }
    emitClose(projectWindow.window, fakeEvent)

    // Wait for the close handler to fully resolve (session teardown is async,
    // and the window is destroyed only once it finishes).
    await vi.waitFor(
      () => {
        expect(projectWindow.context.workspace.hasActiveSession()).toBe(false)
        expect(destroySpy).toHaveBeenCalledTimes(1)
      },
      { timeout: 2000 },
    )

    // Every channel that was live before the workbench window existed must
    // still be live.
    const liveAfter = new Set(stubs.handlers.keys())
    for (const ch of liveBefore) {
      expect(
        liveAfter.has(ch),
        `expected channel '${ch}' to remain registered after a workbench window closed`,
      ).toBe(true)
    }

    // Specifically the channels the import flow relies on must not have been
    // unregistered. (`removeHandler` would push to removeHandlerCalls.)
    const removedDuringClose = stubs.removeHandlerCalls.slice(
      removeHandlerCallsBefore,
    )
    for (const ch of criticalChannels) {
      expect(
        removedDuringClose.includes(ch),
        `removeHandler('${ch}') must NOT be called during close — that's the regression we're guarding`,
      ).toBe(false)
    }

    await instance.dispose()
  })
})

/**
 * LEAK-PROOFING WAVE (项目关闭时保证编译子进程同步关闭) — app/registry
 * teardown conduction.
 *
 * `instance.dispose()` (the path hosts and tests run at app shutdown) must
 * tear down every open workbench window's ACTIVE SESSION, not just the IPC
 * registry. The session's close() is the only hop that reaches devkit and
 * kills the forked compile worker — an app teardown that skips it leaks one
 * compiler process per shutdown-with-open-project.
 *
 * Workspace-level conduction (closeProject → session.close, open-switch,
 * rejecting close) is pinned in
 * `services/workspace/workspace-session-teardown.test.ts`; this describe
 * pins the one hop above it: dispose → closeProject → session.close.
 */
describe('instance.dispose() while a project session is active (app teardown leak guard)', () => {
  it('dispose() closes the workbench window\'s active devkit session exactly once and clears it', async () => {
    const projectDir = '/tmp/projDisposeActive'
    stubs.projectsWithAppJson.add(projectDir)
    stubs.setProjectsJson(JSON.stringify([]))

    const instance = await createDevtoolsRuntime({})
    const projectWindow = await openWorkbenchWindow(instance, projectDir)
    const openResult = await projectWindow.context.workspace.openProject(projectDir)
    expect(openResult.success).toBe(true)
    expect(projectWindow.context.workspace.hasActiveSession()).toBe(true)
    // The open itself must not have closed anything (a fresh service's
    // pre-open disposeSession is a no-op) — baseline for the pin below.
    expect(devkitStubs.sessionClose).not.toHaveBeenCalled()

    await instance.dispose()

    expect(
      devkitStubs.sessionClose,
      'instance.dispose() must close the active session — this is the hop that kills the forked '
      + 'compile worker; disposing only the IPC registry leaks one compiler process per app shutdown',
    ).toHaveBeenCalledTimes(1)
    expect(projectWindow.context.workspace.hasActiveSession()).toBe(false)
  })

  it('dispose() with no active session does not invent a session close (and stays idempotent after a real one)', async () => {
    const projectDir = '/tmp/projDisposeIdempotent'
    stubs.projectsWithAppJson.add(projectDir)
    stubs.setProjectsJson(JSON.stringify([]))

    const instance = await createDevtoolsRuntime({})
    const projectWindow = await openWorkbenchWindow(instance, projectDir)
    await projectWindow.context.workspace.openProject(projectDir)

    await instance.dispose()
    expect(devkitStubs.sessionClose).toHaveBeenCalledTimes(1)

    // A second dispose (host teardown re-entry) must not double-close the
    // already-dead session.
    await instance.dispose()
    expect(
      devkitStubs.sessionClose,
      'double dispose must not double-close the session',
    ).toHaveBeenCalledTimes(1)
  })
})
