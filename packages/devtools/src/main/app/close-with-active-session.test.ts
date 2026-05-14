/**
 * Behavior tests for the main BrowserWindow's `close` event while a project
 * session is active.
 *
 * Contract under test:
 *  - `event.preventDefault()` is called (the window stays open).
 *  - The project session is torn down — `workspace.hasActiveSession()` is
 *    false afterwards.
 *  - The renderer is notified via the `window:navigateBack` channel
 *    (i.e. `mainWindow.webContents.send('window:navigateBack')` is called).
 *  - Every IPC handler that was registered at setup time is STILL registered
 *    afterwards. The regression we guard against: a previous implementation
 *    disposed the whole IPC registry on close, leaving the renderer alive
 *    with no handlers behind it (the Import button silently broke).
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
    })),
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

  const nativeTheme = { themeSource: 'system' }

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
vi.mock('@dimina-kit/devkit', () => ({
  openProject: vi.fn(() =>
    Promise.resolve({
      port: 12345,
      appInfo: { appId: 'fakeApp' },
      close: () => Promise.resolve(),
    }),
  ),
}))

// ── Lazy imports ────────────────────────────────────────────────────────
import { WindowChannel, ProjectsChannel } from '../../shared/ipc-channels.js'
let createWorkbenchApp: typeof import('./app.js').createWorkbenchApp

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  ;({ createWorkbenchApp } = await import('./app.js'))
})

describe('mainWindow close while a project session is active', () => {
  it('calls event.preventDefault, tears down the session, and notifies window:navigateBack', async () => {
    const projectDir = '/tmp/projActive'
    stubs.projectsWithAppJson.add(projectDir)
    stubs.setProjectsJson(JSON.stringify([]))

    const instance = await createWorkbenchApp({}).setup()

    // Open a project directly through the workspace service. Bypasses the
    // IPC layer because what we want to set up is "a session exists".
    const openResult = await instance.context.workspace.openProject(projectDir)
    expect(openResult.success).toBe(true)
    expect(instance.context.workspace.hasActiveSession()).toBe(true)

    const sendSpy = vi.mocked(instance.mainWindow.webContents.send)
    sendSpy.mockClear()

    // Build a fake close event that records preventDefault calls.
    let prevented = 0
    const fakeEvent = {
      preventDefault: () => {
        prevented += 1
      },
    }

    // Fire the close event the same way Electron would.
    ;(instance.mainWindow as unknown as {
      emit: (event: string, ...args: unknown[]) => void
    }).emit('close', fakeEvent)

    // The close handler is fire-and-forget (returns void); wait for the
    // full sequence (session teardown + renderer notification) to settle.
    await vi.waitFor(
      () => {
        expect(instance.context.workspace.hasActiveSession()).toBe(false)
        const calls = sendSpy.mock.calls.filter(
          (call) => call[0] === WindowChannel.NavigateBack,
        )
        expect(calls.length).toBeGreaterThanOrEqual(1)
      },
      { timeout: 2000 },
    )

    expect(prevented).toBe(1)

    // The renderer should have been told to navigate back to the project list.
    const navigateBackCalls = sendSpy.mock.calls.filter(
      (call) => call[0] === WindowChannel.NavigateBack,
    )
    expect(navigateBackCalls).toHaveLength(1)

    await instance.dispose()
  })

  it('does NOT unregister IPC handlers — every channel registered at setup time is still active afterwards', async () => {
    const projectDir = '/tmp/projActiveKeepHandlers'
    stubs.projectsWithAppJson.add(projectDir)
    stubs.setProjectsJson(JSON.stringify([]))

    const instance = await createWorkbenchApp({}).setup()
    await instance.context.workspace.openProject(projectDir)
    expect(instance.context.workspace.hasActiveSession()).toBe(true)

    // Snapshot the live handler set at setup time. We include the critical
    // channels by name explicitly so a regression that drops *only one* still
    // fails this test, plus a broader "every channel that was registered".
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

    const removeHandlerCallsBefore = stubs.removeHandlerCalls.length

    // Fire the close event.
    const fakeEvent = { preventDefault: () => {} }
    ;(instance.mainWindow as unknown as {
      emit: (event: string, ...args: unknown[]) => void
    }).emit('close', fakeEvent)

    // Wait for the close handler to fully resolve (session teardown is async).
    await vi.waitFor(
      () => {
        expect(instance.context.workspace.hasActiveSession()).toBe(false)
      },
      { timeout: 2000 },
    )

    // Every previously-live channel must still be live.
    const liveAfter = new Set(stubs.handlers.keys())
    for (const ch of liveBefore) {
      expect(
        liveAfter.has(ch),
        `expected channel '${ch}' to remain registered after close event`,
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
