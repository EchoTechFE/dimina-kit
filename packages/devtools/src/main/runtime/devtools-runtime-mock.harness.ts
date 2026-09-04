/**
 * Shared electron/fs/`@dimina-kit/devkit` mock core for
 * `window-close-reveal.harness.ts` (app/) and
 * `devtools-backend-before-quit.harness.ts` (runtime/) — both those harnesses
 * drive a REAL runtime (`createDevtoolsRuntime` or `createDevtoolsBackend`)
 * against the same mock set (lifted from `quit-flag-onclose.test.ts`) and
 * previously duplicated it in full; this module holds the part that's
 * actually identical between them.
 *
 * `BrowserWindow` here tracks visible/minimized state and implements
 * `hide`/`isVisible`/`minimize`/`isMinimized`/`restore` on top of `show`/
 * `showInactive` — the window-close-reveal guards need all of that, while the
 * before-quit/shutdown-race tests only ever `destroy()` a window and never
 * observe the extra state, so carrying it there is a no-op.
 *
 * `vi.mock(...)` calls here run once per importing test file's own isolated
 * module graph (vitest scopes mocking per test file). A harness that imports
 * this module chains into that same module graph, so importing THIS module
 * (directly, or transitively through one of the two harnesses above) has the
 * same effect as if each `vi.mock` call were written directly in the test
 * file itself.
 */
import { vi } from 'vitest'

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

  // `WebContents` and `BrowserWindow` below both wrap a `stubs.makeEmitter()`
  // and need the SAME on/once/off/removeListener/emit delegation (the
  // emitter's own methods use `this` internally, so a plain property copy
  // would call them with the wrong receiver — each needs `.bind(em)`). Shared
  // base class instead of re-declaring the same 5 bound fields in both.
  class EmittingStub {
    protected em = stubs.makeEmitter()
    on = this.em.on.bind(this.em)
    once = this.em.once.bind(this.em)
    off = this.em.off.bind(this.em)
    removeListener = this.em.removeListener.bind(this.em)
    emit = this.em.emit.bind(this.em)
  }

  class WebContents extends EmittingStub {
    destroyed = false
    id = Math.floor(Math.random() * 1e6)
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

  class BrowserWindow extends EmittingStub {
    destroyed = false
    // The list window and every workbench window start shown/restored — the
    // reveal/hide guards this state exists for only ever move a window AWAY
    // from it, never establish it.
    visible = true
    minimized = false
    webContents = new WebContents()
    contentView: View | WebContentsView = new WebContentsView()
    isDestroyed = () => this.destroyed
    isVisible = () => this.visible && !this.destroyed
    isMinimized = () => this.minimized
    getContentSize = () => [1280, 980]
    setIcon = vi.fn()
    setTitle = vi.fn()
    show = vi.fn(() => {
      this.visible = true
    })
    showInactive = vi.fn(() => {
      this.visible = true
    })
    hide = vi.fn(() => {
      this.visible = false
    })
    minimize = vi.fn(() => {
      this.minimized = true
    })
    restore = vi.fn(() => {
      this.minimized = false
      this.visible = true
    })
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

export { stubs, devkitStubs }
