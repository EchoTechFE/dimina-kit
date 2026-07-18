/**
 * Shared vitest mock harness for `devtools-backend-before-quit.test.ts` and
 * `devtools-backend-shutdown-race.test.ts` — both drive the REAL
 * `createDevtoolsBackend`/`createDevtoolsRuntime` against this same
 * electron/fs/`@dimina-kit/devkit`/view-manager mock set (lifted from
 * `quit-flag-onclose.test.ts`), split out to keep each test file under the
 * repo's 500-line file-length ratchet without duplicating ~350 lines of
 * mock setup between them.
 *
 * `vi.mock(...)` calls here run once per importing test file's own isolated
 * module graph (vitest scopes mocking per test file), so importing this
 * module has the same effect as if each call were written directly in the
 * importing file — both test files' `beforeEach` still dynamically
 * `await import('./devtools-backend.js')` AFTER `vi.resetModules()`, well
 * after this module's mock registrations have already run.
 */
import { beforeEach, expect, vi } from 'vitest'
import type { WorkbenchAppConfig } from '../../shared/types.js'
import type { RuntimeBackend } from '@dimina-kit/electron-deck'

// ── Hoisted stub state (lifted from quit-flag-onclose.test.ts) ────────────
// `export const x = vi.hoisted(...)` is rejected by vitest's hoisting
// transform ("Cannot export hoisted variable") — declare then export below.
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
// `before-quit` listener that the test fires directly.
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
    webContents = new WebContents()
    contentView: View | WebContentsView = new WebContentsView()
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

// ── view-manager spy shim ───────────────────────────────────────────────
// `createDevtoolsBackend` keeps its assembled `instance` in a private
// closure — the returned `RuntimeBackend` exposes no getter for
// `instance.context.views`. Wrapping `createViewManager` here (real
// implementation, just observed) gives the test a handle on the exact
// `ViewManager` the backend's `assemble` wires up, equivalent to
// `vi.spyOn(instance.context.views, 'disposeAll')` without needing the
// backend to leak its internals.
const viewManagerStubs = vi.hoisted(() => ({
  createdManagers: [] as Array<{ disposeAll: () => void }>,
}))

vi.mock('../services/views/view-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/views/view-manager.js')>()
  return {
    ...actual,
    createViewManager: (ctx: Parameters<typeof actual.createViewManager>[0]) => {
      const real = actual.createViewManager(ctx)
      vi.spyOn(real, 'disposeAll')
      viewManagerStubs.createdManagers.push(real)
      return real
    },
  }
})

export { stubs, devkitStubs, viewManagerStubs }

/**
 * Shared per-test setup both `devtools-backend-before-quit.test.ts` and
 * `devtools-backend-shutdown-race.test.ts` need identically: reset modules
 * (fresh `let`-scoped module-level state in `devtools-backend.ts` each
 * test), reset the mock harness above, and dynamically re-import `electron`
 * + `createDevtoolsBackend` — dynamic, not a static top-level import,
 * because it must happen AFTER `vi.resetModules()` picks up a fresh module
 * instance each test. Registers its own `beforeEach`; call once per
 * describing test file. Returns a mutable state object (not individual
 * values) because `beforeEach` reassigns its fields once per test, after
 * this function itself has already returned.
 */
export interface BackendTestState {
  createDevtoolsBackend: typeof import('./devtools-backend.js').createDevtoolsBackend
  electron: typeof import('electron')
}

export function registerBackendTestLifecycle(): BackendTestState {
  const state = {} as BackendTestState
  beforeEach(async () => {
    vi.resetModules()
    stubs.reset()
    devkitStubs.sessionClose.mockClear()
    viewManagerStubs.createdManagers.length = 0
    state.electron = await import('electron')
    ;({ createDevtoolsBackend: state.createDevtoolsBackend } = await import('./devtools-backend.js'))
  })
  return state
}

/**
 * Shared setup for the two tests (one in `devtools-backend-before-quit.test.ts`,
 * one in `devtools-backend-shutdown-race.test.ts`) that need to observe
 * `assemble()` PAUSED mid-flight, inside a still-pending `config.onSetup`:
 * builds the backend with a gated `onSetup`, runs `beforeReady`/`assemble`,
 * and waits until the assembled `ViewManager` is actually reachable (proof
 * `createDevtoolsRuntime` has progressed past instance construction) before
 * handing control back — the caller then fires whatever quit-path event it's
 * testing while `onSetup` is still gated, and is responsible for calling
 * `releaseOnSetup()` + awaiting `assemblePromise` itself.
 */
export async function startAssemblingWithGatedOnSetup(
  createDevtoolsBackend: BackendTestState['createDevtoolsBackend'],
  extraConfig: Omit<WorkbenchAppConfig, 'onSetup'> = {},
): Promise<{
  backend: RuntimeBackend
  assemblePromise: Promise<void>
  releaseOnSetup: () => void
}> {
  let releaseOnSetup: () => void = () => {}
  const onSetupGate = new Promise<void>((resolve) => {
    releaseOnSetup = resolve
  })

  const backend = createDevtoolsBackend({
    ...extraConfig,
    onSetup: async () => {
      await onSetupGate
    },
  })

  backend.beforeReady?.(
    {} as unknown as Parameters<NonNullable<typeof backend.beforeReady>>[0],
  )
  const assemblePromise = Promise.resolve(
    backend.assemble({} as unknown as Parameters<typeof backend.assemble>[0]),
  )

  // Let `assemble` progress through `createDevtoolsRuntime` up to (and into)
  // the pending `onSetup` gate — the instance must exist by then.
  await vi.waitFor(() => {
    expect(viewManagerStubs.createdManagers.length).toBeGreaterThan(0)
  })

  return { backend, assemblePromise, releaseOnSetup }
}
