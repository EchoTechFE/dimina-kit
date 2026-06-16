/**
 * ⌘Q QUIT-FLAG CONTRACT (host-shell extensibility) — lifecycle + onClose.
 *
 * Bug guarded against: with a project open, pressing ⌘Q fires the main
 * window's `close` event, the onClose handler unconditionally
 * `preventDefault()`s + `closeProject()`s, and the application never quits —
 * the quit is swallowed and turned into "close the project".
 *
 * The fix introduces an app-level quit flag:
 *  - `lifecycle.isAppQuitting()` starts `false`.
 *  - `registerAppLifecycle()` wires `app.on('before-quit', …)`; once that
 *    handler runs, `isAppQuitting()` returns `true`.
 *  - The main-window onClose consults it: when quitting, it must NOT
 *    `preventDefault()` and must NOT tear the project down (let the real
 *    quit proceed). When NOT quitting and a session is active, it keeps the
 *    original behaviour (preventDefault + closeProject + navigateBack).
 *
 * Two layers are pinned:
 *  1. lifecycle.ts: the flag flips after before-quit.
 *  2. app.ts createDevtoolsRuntime: the wired onClose honours the flag.
 *
 * Harness for layer 2 lifted from `close-with-active-session.test.ts`
 * (electron + fs + devkit mocks, real createDevtoolsRuntime).
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
// `app` is a live emitter so `registerAppLifecycle` can attach a
// `before-quit` listener that tests fire to flip the quit flag.
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

import { WindowChannel } from '../../shared/ipc-channels.js'
let createDevtoolsRuntime: typeof import('./app.js').createDevtoolsRuntime
let registerAppLifecycle: typeof import('./lifecycle.js').registerAppLifecycle
// Will only exist once the fix lands; referencing it red-flags the contract.
let isAppQuitting: typeof import('./lifecycle.js').isAppQuitting
let electron: typeof import('electron')

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  devkitStubs.sessionClose.mockClear()
  electron = await import('electron')
  ;({ createDevtoolsRuntime } = await import('./app.js'))
  ;({ registerAppLifecycle, isAppQuitting } = await import('./lifecycle.js'))
})

describe('lifecycle: app-quit flag', () => {
  it('isAppQuitting() starts false and flips to true once before-quit fires', () => {
    expect(
      isAppQuitting(),
      'a fresh process is not quitting until before-quit is observed',
    ).toBe(false)

    registerAppLifecycle()

    // Still false: registering listeners must not pretend we are quitting.
    expect(isAppQuitting()).toBe(false)

    // Electron fires before-quit on real ⌘Q / app.quit().
    ;(electron.app as unknown as {
      emit: (event: string, ...args: unknown[]) => void
    }).emit('before-quit', { preventDefault: () => {} })

    expect(
      isAppQuitting(),
      'after before-quit the shell must know a real quit is underway',
    ).toBe(true)
  })
})

describe('mainWindow onClose honours the app-quit flag', () => {
  async function openProject() {
    const projectDir = '/tmp/projQuitFlag'
    stubs.projectsWithAppJson.add(projectDir)
    stubs.setProjectsJson(JSON.stringify([]))
    const instance = await createDevtoolsRuntime({})
    const openResult = await instance.context.workspace.openProject(projectDir)
    expect(openResult.success).toBe(true)
    expect(instance.context.workspace.hasActiveSession()).toBe(true)
    return instance
  }

  it('when quitting (before-quit fired): does NOT preventDefault and does NOT close the project', async () => {
    const instance = await openProject()

    // Simulate the real ⌘Q ordering: Electron emits before-quit, then the
    // window close event for each open window.
    registerAppLifecycle()
    ;(electron.app as unknown as {
      emit: (event: string, ...args: unknown[]) => void
    }).emit('before-quit', { preventDefault: () => {} })
    expect(isAppQuitting()).toBe(true)

    const sendSpy = vi.mocked(instance.mainWindow.webContents.send)
    sendSpy.mockClear()

    let prevented = 0
    const fakeEvent = { preventDefault: () => { prevented += 1 } }
    ;(instance.mainWindow as unknown as {
      emit: (event: string, ...args: unknown[]) => void
    }).emit('close', fakeEvent)

    // Give any (incorrect) async closeProject a chance to run.
    await new Promise((r) => setTimeout(r, 50))

    expect(
      prevented,
      'during a real quit the close must be allowed through — preventDefault here turns ⌘Q '
      + 'into "close the project" and the app never exits',
    ).toBe(0)
    expect(
      instance.context.workspace.hasActiveSession(),
      'quitting must not tear the project down via the close handler — the app is exiting whole',
    ).toBe(true)
    const navBack = sendSpy.mock.calls.filter((c) => c[0] === WindowChannel.NavigateBack)
    expect(
      navBack,
      'a real quit must not push the renderer back to the project list',
    ).toHaveLength(0)

    await instance.dispose()
  })

  it('when NOT quitting and a session is active: keeps original behaviour (preventDefault + closeProject + navigateBack)', async () => {
    const instance = await openProject()
    // before-quit NOT fired → isAppQuitting() stays false.
    expect(isAppQuitting()).toBe(false)

    const sendSpy = vi.mocked(instance.mainWindow.webContents.send)
    sendSpy.mockClear()

    let prevented = 0
    const fakeEvent = { preventDefault: () => { prevented += 1 } }
    ;(instance.mainWindow as unknown as {
      emit: (event: string, ...args: unknown[]) => void
    }).emit('close', fakeEvent)

    await vi.waitFor(
      () => {
        expect(instance.context.workspace.hasActiveSession()).toBe(false)
        const calls = sendSpy.mock.calls.filter((c) => c[0] === WindowChannel.NavigateBack)
        expect(calls.length).toBeGreaterThanOrEqual(1)
      },
      { timeout: 2000 },
    )

    expect(prevented, 'a plain close-while-open stays in the workbench').toBe(1)

    await instance.dispose()
  })
})
