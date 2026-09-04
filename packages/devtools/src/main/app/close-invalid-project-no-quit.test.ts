/**
 * WORKBENCH-WINDOW CLOSE CONTRACT — closing a workbench window after a FAILED
 * project open (the unconditional-teardown guard in workbench-window.ts).
 *
 * Bug guarded against: the user tries to open a non-existent / invalid
 * mini-program project. `openProject()` fails and no session is ever created
 * (`workspace.hasActiveSession()` stays false throughout), yet the window
 * already owns views, an editor server and IPC registrations. A close handler
 * that gates its teardown on `hasActiveSession()` sees nothing to protect and
 * lets the close fall straight through — the window is destroyed with its
 * resources still live, and back when that was the only window the whole
 * application went down with it (`window-all-closed` → `app.quit()`).
 *
 * Contract: a workbench window's close tears that window down
 * UNCONDITIONALLY — session or not. Teardown runs, the window is destroyed
 * only once teardown finishes, and neither the application nor the
 * project-list window goes with it.
 *
 * Window identity is what the contract keys off now: a workbench window IS the
 * project screen, so main never has to ask a renderer which screen it is on.
 * The project-list window owns no project and keeps the opposite contract —
 * its close passes through so the app can quit.
 *
 * Harness (electron + fs + devkit mocks, real createDevtoolsRuntime) lifted
 * from `double-close-quit.test.ts` / `close-with-active-session.test.ts`.
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
// window survives a close that should be prevented.
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
    // Mini-game detection files never exist in these mini-program-only fixtures.
    if (/[\\/](game\.json|game\.js|game\.ts|project\.config\.json|project\.private\.config\.json)$/.test(s)) {
      return false
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

vi.mock('@dimina-kit/devkit', () => ({
  openProject: vi.fn(() =>
    Promise.resolve({
      port: 12345,
      appInfo: { appId: 'fakeApp' },
      close: vi.fn(() => Promise.resolve()),
    }),
  ),
}))

// ── Lazy imports ────────────────────────────────────────────────────────
let createDevtoolsRuntime: typeof import('./app.js').createDevtoolsRuntime

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  await import('electron')
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

function emitClose(win: unknown, fakeEvent: unknown) {
  ;(win as { emit: (event: string, ...args: unknown[]) => void }).emit('close', fakeEvent)
}

/** Opens `dir` in its own workbench window and returns that window's record. */
async function openWorkbenchWindow(instance: Instance, dir: string): Promise<ProjectWindow> {
  await instance.openProjectWindow({ path: dir })
  const [projectWindow] = instance.projectWindows()
  expect(projectWindow, 'openProjectWindow must publish the window it opened').toBeTruthy()
  return projectWindow!
}

describe('workbench window close after a failed project open (no session was ever created)', () => {
  it('tears the window down anyway, destroys only that window, and never quits the app', async () => {
    // Do NOT add the dir to projectsWithAppJson: openProject() must fail
    // because app.json is missing, exactly like opening a non-existent /
    // invalid mini-program project.
    stubs.setProjectsJson(JSON.stringify([]))

    const instance = await createDevtoolsRuntime({})
    const projectWindow = await openWorkbenchWindow(instance, '/tmp/doesNotExist')

    const openResult = await projectWindow.context.workspace.openProject('/tmp/doesNotExist')
    expect(openResult.success, 'opening a non-existent project must fail').toBe(false)
    expect(
      projectWindow.context.workspace.hasActiveSession(),
      'a failed open must leave no active session',
    ).toBe(false)

    // `closeProject()` is the teardown hop that must run even with nothing to
    // close — it is what releases the window's views and editor server.
    const closeProjectSpy = vi.spyOn(projectWindow.context.workspace, 'closeProject')
    const quitSpy = vi.mocked((await import('electron')).app.quit)
    const listDestroySpy = vi.mocked(instance.mainWindow.destroy)
    const windowDestroySpy = vi.mocked(projectWindow.window.destroy)
    quitSpy.mockClear()
    listDestroySpy.mockClear()
    windowDestroySpy.mockClear()

    const evt = makeCloseEvent()
    emitClose(projectWindow.window, evt.event)

    await vi.waitFor(() => {
      expect(windowDestroySpy).toHaveBeenCalledTimes(1)
    }, { timeout: 2000 })

    expect(
      evt.prevented,
      'the close must be held back exactly once so teardown finishes before the window goes',
    ).toBe(1)
    expect(
      closeProjectSpy,
      'teardown must run even with no session — that is what releases the views and editor server',
    ).toHaveBeenCalledTimes(1)
    expect(quitSpy, 'closing one workbench window must never quit the application').not.toHaveBeenCalled()
    expect(
      listDestroySpy,
      'the project list window must survive a workbench window closing',
    ).not.toHaveBeenCalled()
    expect(instance.mainWindow.isDestroyed()).toBe(false)

    await instance.dispose()
  })
})

describe('project-list window close', () => {
  it('passes the close through so the app can quit', async () => {
    stubs.setProjectsJson(JSON.stringify([]))

    const instance = await createDevtoolsRuntime({})
    expect(instance.context.workspace.hasActiveSession()).toBe(false)

    const evt = makeCloseEvent()
    emitClose(instance.mainWindow, evt.event)

    await new Promise((r) => setTimeout(r, 0))

    expect(
      evt.prevented,
      'the list window owns no project, so its close must pass through and let the app quit',
    ).toBe(0)

    await instance.dispose()
  })
})
