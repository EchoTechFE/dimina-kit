/**
 * WINDOW-CLOSE CONTRACT — closing while the renderer is on the PROJECT screen
 * after a FAILED project open (onClose in app.ts wireAppWindowEvents).
 *
 * Bug guarded against: the user tries to open a non-existent / invalid
 * mini-program project. `openProject()` fails and no session is ever created
 * (`workspace.hasActiveSession()` stays false throughout). The renderer,
 * however, has already navigated to its in-project screen (it reports this
 * via `WindowChannel.ScreenState` the moment it enters the project route,
 * BEFORE the open call resolves) and shows a "compile failed" error overlay
 * there. The close handler currently keys its preventDefault decision purely
 * off `hasActiveSession()`, so with no session it sees nothing to protect and
 * lets the close pass through — the last window is destroyed, triggering
 * `window-all-closed` → `app.quit()`, and the whole app exits instead of
 * returning the user to the project list.
 *
 * Contract: the close decision must consult the renderer's last-reported
 * screen (`WindowChannel.ScreenState`), not just session presence. Closing
 * while the reported screen is `'project'` must preventDefault and send
 * `WindowChannel.NavigateBack` so the renderer returns to the list, even with
 * no active session. Closing while the reported screen is `'list'` must pass
 * through so the app can quit normally.
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
import { WindowChannel } from '../../shared/ipc-channels.js'
// `WindowChannel` does not yet export a screen-state channel — the renderer
// has no way to report its current top-level screen to main at all. This is
// itself part of the guarded gap: main has nothing to consult, so it can only
// ever key off `hasActiveSession()`. Once the channel is added to
// `shared/ipc-channels.ts`, this local constant must match its value exactly.
const SCREEN_STATE_CHANNEL = 'window:screenState'
let createDevtoolsRuntime: typeof import('./app.js').createDevtoolsRuntime

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  await import('electron')
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

function emitClose(instance: Awaited<ReturnType<typeof createDevtoolsRuntime>>, fakeEvent: unknown) {
  ;(instance.mainWindow as unknown as {
    emit: (event: string, ...args: unknown[]) => void
  }).emit('close', fakeEvent)
}

/**
 * Reports the renderer's current top-level screen via the registered IPC
 * handler, mirroring the renderer calling
 * `ipcRenderer.invoke(SCREEN_STATE_CHANNEL, screen)`. No handler is currently
 * registered for this channel at all — main has no way to learn the
 * renderer's screen — so this is a no-op today. That is itself the gap this
 * file guards: the close decision below falls back to whatever main can
 * currently observe (only `hasActiveSession()`), which is precisely the bug.
 */
async function reportScreen(
  instance: Awaited<ReturnType<typeof createDevtoolsRuntime>>,
  screen: 'project' | 'list',
) {
  const handler = stubs.handlers.get(SCREEN_STATE_CHANNEL)
  // The fake IpcMainInvokeEvent must carry the main window's webContents as its
  // sender: every renderer→main invoke passes the sender-policy gate, which
  // trusts the main-window renderer. A bare `{}` has no sender and crashes the
  // gate before the handler runs.
  const event = { sender: instance.mainWindow.webContents }
  await handler?.(event, screen)
}

describe('window close after a failed project open (no session, renderer stuck on project screen)', () => {
  it('preventDefaults the close and navigates the renderer back to the list instead of quitting', async () => {
    // Do NOT add the dir to projectsWithAppJson: openProject() must fail
    // because app.json is missing, exactly like opening a non-existent /
    // invalid mini-program project.
    stubs.setProjectsJson(JSON.stringify([]))

    const instance = await createDevtoolsRuntime({})

    const openResult = await instance.context.workspace.openProject('/tmp/doesNotExist')
    expect(openResult.success, 'opening a non-existent project must fail').toBe(false)
    expect(
      instance.context.workspace.hasActiveSession(),
      'a failed open must leave no active session',
    ).toBe(false)

    // The renderer navigated into the project screen (to show the compile
    // failed overlay) before the open call resolved.
    await reportScreen(instance, 'project')

    const quitSpy = vi.mocked((await import('electron')).app.quit)
    const destroySpy = vi.mocked(instance.mainWindow.destroy)
    const sendSpy = vi.mocked(instance.mainWindow.webContents.send)
    quitSpy.mockClear()
    destroySpy.mockClear()
    sendSpy.mockClear()

    const evt = makeCloseEvent()
    emitClose(instance, evt.event)

    await new Promise((r) => setTimeout(r, 0))
    await vi.waitFor(() => {
      expect(evt.prevented).toBeGreaterThanOrEqual(1)
    })

    expect(
      evt.prevented,
      'closing while stuck on the project screen (even with no session) must preventDefault exactly once',
    ).toBe(1)
    expect(quitSpy, 'the app must not quit while the renderer is on the project screen').not.toHaveBeenCalled()
    expect(destroySpy, 'the main window must not be destroyed while the renderer is on the project screen').not.toHaveBeenCalled()
    expect(instance.mainWindow.isDestroyed()).toBe(false)

    const navigateBackCalls = sendSpy.mock.calls.filter(
      (c) => c[0] === WindowChannel.NavigateBack,
    )
    expect(
      navigateBackCalls.length,
      'the renderer must be told to navigate back to the project list',
    ).toBeGreaterThanOrEqual(1)

    await instance.dispose()
  })
})

describe('window close while the renderer is on the project list (no session)', () => {
  it('passes the close through so the app can quit', async () => {
    stubs.setProjectsJson(JSON.stringify([]))

    const instance = await createDevtoolsRuntime({})
    expect(instance.context.workspace.hasActiveSession()).toBe(false)

    await reportScreen(instance, 'project')
    await reportScreen(instance, 'list')

    const evt = makeCloseEvent()
    emitClose(instance, evt.event)

    await new Promise((r) => setTimeout(r, 0))

    expect(
      evt.prevented,
      'with the renderer back on the list screen the close must pass through so the app can quit',
    ).toBe(0)

    await instance.dispose()
  })
})
