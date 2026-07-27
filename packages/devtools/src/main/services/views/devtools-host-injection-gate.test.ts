/**
 * `native-simulator-devtools-host.ts` must route every front-end injection
 * that touches a `.instance()`-style singleton through
 * `frontend-bootstrap-gate.ts`'s `whenFrontendBootstrapped` BEFORE firing
 * `executeJavaScript` at the DevTools front-end host wc (see that module's
 * header comment for the bootstrap-killing failure mode this guards against).
 *
 * Two gated injection points under test:
 * - `applyConsoleFilter` (kind 'console-filter'): both
 *   `buildConsoleFilterScript()` and `buildLiveConsoleFilterScript()` must
 *   stay unapplied until the gate resolves true, and must never apply at all
 *   if it resolves false.
 * - the console-default panel-selection script (kind 'console-default'):
 *   same gating, and its content must drive
 *   `EUI.ViewManager.ViewManager.instance().showView('console')` — never
 *   `globalThis.UI`, which does not exist on this front-end build.
 *
 * `customizeDevtoolsTabs` is the one documented pre-gate exception (it only
 * edits the view-extension registry, never touches a singleton) and must
 * keep injecting immediately regardless of gate state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RenderEvent, ServiceHostReadyEvent } from '../../ipc/bridge-router.js'

const { whenFrontendBootstrappedMock } = vi.hoisted(() => ({
  whenFrontendBootstrappedMock: vi.fn(),
}))

vi.mock('./frontend-bootstrap-gate.js', () => ({
  FRONTEND_BOOTSTRAP_PROBE_SCRIPT: '(() => false)()',
  whenFrontendBootstrapped: whenFrontendBootstrappedMock,
}))

// ── electron stub ───────────────────────────────────────────────────────────
// Mirrors view-manager-devtools-host-repoint.test.ts's stub, with one
// deliberate difference: the DevTools front-end host wc reports itself as
// ALREADY SETTLED (non-empty getURL, not loading) from construction, so
// `injectWhenReady` (inject-when-ready.ts's `isFrontendSettled`) runs an
// injector's callback synchronously instead of waiting on a
// `did-stop-loading` this stub's mocked `once` never actually delivers —
// letting these tests observe `executeJavaScript` calls right after
// triggering attach/service-ready without needing to fake that event too.
type StubWebContents = {
  destroyed: boolean
  id: number
  isDestroyed: () => boolean
  close: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  setZoomFactor: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  setMaxListeners: ReturnType<typeof vi.fn>
  getMaxListeners: ReturnType<typeof vi.fn>
  isLoading: ReturnType<typeof vi.fn>
  executeJavaScript: ReturnType<typeof vi.fn>
  setDevToolsWebContents: ReturnType<typeof vi.fn>
  openDevTools: ReturnType<typeof vi.fn>
  isDevToolsOpened: ReturnType<typeof vi.fn>
  closeDevTools: ReturnType<typeof vi.fn>
  getURL: ReturnType<typeof vi.fn>
}
type StubView = {
  webContents: StubWebContents
  setBounds: ReturnType<typeof vi.fn>
  setBackgroundColor: ReturnType<typeof vi.fn>
}

const constructed: StubView[] = []
const serviceWcRegistry = new Map<number, StubWebContents>()

vi.mock('electron', () => {
  let nextId = 1
  class WebContentsView {
    webContents: StubWebContents
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
    constructor(_opts?: unknown) {
      const id = nextId++
      this.webContents = {
        destroyed: false,
        id,
        isDestroyed() { return this.destroyed },
        close: vi.fn(function (this: StubWebContents) { this.destroyed = true }),
        loadURL: vi.fn(() => Promise.resolve()),
        loadFile: vi.fn(() => Promise.resolve()),
        on: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        setZoomFactor: vi.fn(),
        send: vi.fn(),
        setMaxListeners: vi.fn(),
        getMaxListeners: vi.fn(() => 10),
        isLoading: vi.fn(() => false),
        getURL: vi.fn(() => 'devtools://devtools/bundled/inspector.html'),
        executeJavaScript: vi.fn(() => Promise.resolve()),
        setDevToolsWebContents: vi.fn(),
        openDevTools: vi.fn(),
        isDevToolsOpened: vi.fn(() => false),
        closeDevTools: vi.fn(),
      }
      constructed.push(this as unknown as StubView)
    }
  }
  const ipcMain = {
    on: vi.fn(),
    removeListener: vi.fn(),
    handle: vi.fn(),
    removeHandler: vi.fn(),
  }
  return {
    WebContentsView,
    ipcMain,
    shell: { openExternal: vi.fn() },
    nativeTheme: { shouldUseDarkColors: false, on: vi.fn(), removeListener: vi.fn() },
    webContents: {
      fromId: vi.fn((id: number) => serviceWcRegistry.get(id)),
      getAllWebContents: vi.fn(() => []),
    },
    default: { ipcMain },
  }
})

vi.mock('../../utils/paths.js', () => ({
  mainPreloadPath: '/stub/preload.js',
  hostToolbarPreloadPath: '/stub/host-toolbar-preload.js',
  cjsSiblingPreloadPath: (p: string) => p.replace(/\.js$/, '.cjs'),
  devtoolsPackageRoot: '/stub/devtools-pkg-root',
}))

// Import AFTER mocks so view-manager (and native-simulator-devtools-host)
// pick up the stubs.
import { createViewManager } from './view-manager.js'
import { buildCustomizeTabsScript } from './devtools-tabs.js'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

const SIM_URL = 'http://localhost:7788/simulator.html?appId=gate'

/** A hidden SERVICE-HOST BrowserWindow wc (top-level, can host DevTools). */
function makeServiceWc(id: number): StubWebContents {
  const wc: StubWebContents = {
    destroyed: false,
    id,
    isDestroyed() { return this.destroyed },
    close: vi.fn(),
    loadURL: vi.fn(() => Promise.resolve()),
    loadFile: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setZoomFactor: vi.fn(),
    send: vi.fn(),
    setMaxListeners: vi.fn(),
    getMaxListeners: vi.fn(() => 10),
    isLoading: vi.fn(() => false),
    getURL: vi.fn(() => ''),
    executeJavaScript: vi.fn(() => Promise.resolve()),
    setDevToolsWebContents: vi.fn(),
    openDevTools: vi.fn(),
    isDevToolsOpened: vi.fn(() => true),
    closeDevTools: vi.fn(),
  }
  serviceWcRegistry.set(id, wc)
  return wc
}

function makeContext() {
  const addChildView = vi.fn()
  const removeChildView = vi.fn()
  const contentView = { addChildView, removeChildView, children: [] }
  const mainWindow = {
    destroyed: false,
    contentView,
    isDestroyed() { return this.destroyed },
    getContentSize: () => [1280, 980],
  }
  const notify = {
    popoverInit: vi.fn(),
    popoverClosed: vi.fn(),
    hostToolbarHeightChanged: vi.fn(),
  }

  let currentServiceWc: StubWebContents | null = null
  const renderEventListeners = new Set<(event: RenderEvent) => void>()
  const serviceHostReadyListeners = new Set<(event: ServiceHostReadyEvent) => void>()
  const bridge = {
    isNativeHost: () => true,
    resolveRenderWc: () => null,
    getServiceWc: vi.fn(() => currentServiceWc),
    getServiceWcForBridge: () => null,
    getActiveRenderWc: () => null,
    getActiveBridgeId: () => null,
    onRenderEvent: (listener: (event: RenderEvent) => void) => {
      renderEventListeners.add(listener)
      return () => renderEventListeners.delete(listener)
    },
    onServiceHostReady: (listener: (event: ServiceHostReadyEvent) => void) => {
      serviceHostReadyListeners.add(listener)
      return () => serviceHostReadyListeners.delete(listener)
    },
    getDevice: () => null,
    setDevice: () => {},
    disposeSessionsForSimulator: () => Promise.resolve(),
  }

  function setActiveServiceWc(wc: StubWebContents): void {
    currentServiceWc = wc
  }
  function emitServiceHostReady(event: ServiceHostReadyEvent): void {
    for (const l of [...serviceHostReadyListeners]) l(event)
  }

  return {
    setActiveServiceWc,
    emitServiceHostReady,
    ctx: {
      windows: {
        mainWindow: mainWindow as unknown as import('electron').BrowserWindow,
      } as import('../window-service.js').WindowService,
      rendererDir: '/stub/renderer',
      panels: ['console', 'wxml', 'storage', 'appdata'],
      notify: notify as unknown as import('../notifications/renderer-notifier.js').RendererNotifier,
      connections: createConnectionRegistry(),
      preloadPath: '/stub/sim-preload.js',
      bridge: bridge as unknown as import('../workbench-context.js').WorkbenchContext['bridge'],
    },
  }
}

/** All `executeJavaScript` call arguments recorded on `wc`, as strings. */
function injectedScripts(wc: StubWebContents): string[] {
  return wc.executeJavaScript.mock.calls.map((c) => c[0] as string)
}

beforeEach(() => {
  constructed.length = 0
  vi.useFakeTimers()
  // Default: the gate is asked and never answers — every test that cares
  // about a resolved value overrides this with a controllable promise.
  whenFrontendBootstrappedMock.mockReset()
  whenFrontendBootstrappedMock.mockImplementation(() => new Promise<boolean>(() => {}))
})

afterEach(() => {
  vi.useRealTimers()
})

/** Flush the microtask queue a few times — enough for a `.then()` chain off
 * the mocked gate promise to run, independent of fake timers (which only
 * affect macrotasks). */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('applyConsoleFilter injection point (kind: console-filter)', () => {
  it('does not inject either console-filter script before the bootstrap gate resolves', () => {
    const { ctx, emitServiceHostReady } = makeContext()
    const mgr = createViewManager(ctx)
    const service = makeServiceWc(701)

    mgr.attachNativeSimulator(SIM_URL, 375)
    const devtoolsWc = constructed[1]!.webContents
    emitServiceHostReady({ appId: 'gate', appSessionId: 's1', serviceWcId: service.id })

    const scripts = injectedScripts(devtoolsWc)
    expect(scripts.some((s) => s.includes('console.text-filter'))).toBe(false)
    expect(scripts.some((s) => s.includes('textFilterUI'))).toBe(false)
  })

  it('injects both console-filter scripts once the bootstrap gate resolves true', async () => {
    let resolveGate: (v: boolean) => void = () => {}
    whenFrontendBootstrappedMock.mockImplementation(() => new Promise<boolean>((resolve) => { resolveGate = resolve }))

    const { ctx, emitServiceHostReady } = makeContext()
    const mgr = createViewManager(ctx)
    const service = makeServiceWc(702)

    mgr.attachNativeSimulator(SIM_URL, 375)
    const devtoolsWc = constructed[1]!.webContents
    emitServiceHostReady({ appId: 'gate', appSessionId: 's1', serviceWcId: service.id })

    expect(
      injectedScripts(devtoolsWc).some((s) => s.includes('console.text-filter') || s.includes('textFilterUI')),
      'must stay unapplied while the gate promise is still pending',
    ).toBe(false)

    resolveGate(true)
    await flushMicrotasks()

    const scripts = injectedScripts(devtoolsWc)
    expect(scripts.some((s) => s.includes('console.text-filter'))).toBe(true)
    expect(scripts.some((s) => s.includes('textFilterUI'))).toBe(true)
  })

  it('never injects either console-filter script when the bootstrap gate resolves false (silent degradation)', async () => {
    let resolveGate: (v: boolean) => void = () => {}
    whenFrontendBootstrappedMock.mockImplementation(() => new Promise<boolean>((resolve) => { resolveGate = resolve }))

    const { ctx, emitServiceHostReady } = makeContext()
    const mgr = createViewManager(ctx)
    const service = makeServiceWc(703)

    mgr.attachNativeSimulator(SIM_URL, 375)
    const devtoolsWc = constructed[1]!.webContents
    emitServiceHostReady({ appId: 'gate', appSessionId: 's1', serviceWcId: service.id })

    resolveGate(false)
    await flushMicrotasks()
    vi.advanceTimersByTime(5000)

    const scripts = injectedScripts(devtoolsWc)
    expect(scripts.some((s) => s.includes('console.text-filter'))).toBe(false)
    expect(scripts.some((s) => s.includes('textFilterUI'))).toBe(false)
  })
})

describe('console-default injection point (kind: console-default)', () => {
  it('does not drive any console-panel-selection call before the bootstrap gate resolves', () => {
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)
    const devtoolsWc = constructed[1]!.webContents

    const scripts = injectedScripts(devtoolsWc)
    expect(scripts.some((s) => s.includes("showView('console')"))).toBe(false)
  })

  it('drives EUI.ViewManager.ViewManager.instance().showView(\'console\'), never globalThis.UI, once the bootstrap gate resolves true', async () => {
    let resolveGate: (v: boolean) => void = () => {}
    whenFrontendBootstrappedMock.mockImplementation(() => new Promise<boolean>((resolve) => { resolveGate = resolve }))

    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator(SIM_URL, 375)
    const devtoolsWc = constructed[1]!.webContents

    resolveGate(true)
    await flushMicrotasks()

    const consoleDefaultScript = injectedScripts(devtoolsWc).find((s) => s.includes("showView('console')"))
    expect(consoleDefaultScript, 'the console-default script must eventually be injected once bootstrap is ready').toBeTruthy()
    expect(consoleDefaultScript).toMatch(/EUI\.ViewManager\.ViewManager\.instance/)
    expect(consoleDefaultScript).not.toMatch(/globalThis\.UI\b/)
  })
})

describe('customizeDevtoolsTabs: the one documented pre-gate injection', () => {
  it('injects the tab-customization script immediately, even while the bootstrap gate is still pending', () => {
    // The default beforeEach mock leaves the gate pending forever.
    const { ctx, emitServiceHostReady } = makeContext()
    const mgr = createViewManager(ctx)
    const service = makeServiceWc(704)

    mgr.attachNativeSimulator(SIM_URL, 375)
    const devtoolsWc = constructed[1]!.webContents
    emitServiceHostReady({ appId: 'gate', appSessionId: 's1', serviceWcId: service.id })

    const expectedScript = buildCustomizeTabsScript()
    expect(injectedScripts(devtoolsWc).some((s) => s === expectedScript)).toBe(true)
  })
})
