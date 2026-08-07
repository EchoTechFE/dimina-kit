/**
 * `native-simulator-devtools-host.ts` must route every front-end injection
 * that touches a `.instance()`-style singleton through
 * `frontend-bootstrap-gate.ts`'s `whenFrontendBootstrapped` BEFORE firing
 * `executeJavaScript` at the DevTools front-end host wc (see that module's
 * header comment for the bootstrap-killing failure mode this guards against).
 *
 * Two gated injection points under test:
 * - `applyConsoleFilter` (kind 'console-filter'): `buildInternalLogHideScript()`
 *   must stay unapplied until the gate resolves true, and must never apply at
 *   all if it resolves false.
 * - the console-default panel-selection script (kind 'console-default'):
 *   same gating, and its content must drive
 *   `EUI.ViewManager.ViewManager.instance().showView('console')` — never
 *   `globalThis.UI`, which does not exist on this front-end build.
 *
 * `customizeDevtoolsTabs` is the one documented pre-gate exception (it only
 * edits the view-extension registry, never touches a singleton) and must
 * keep injecting immediately regardless of gate state.
 *
 * A final scan covers the whole injection surface rather than one point:
 * whatever any of these scripts does, none of them may write a control the
 * developer owns (Console text filter, Network filter bar / toggles) — see
 * `DEVELOPER_OWNED_CONTROLS`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RenderEvent, ServiceHostReadyEvent } from '../../ipc/bridge-router.js'

const { whenFrontendBootstrappedMock } = vi.hoisted(() => ({
  whenFrontendBootstrappedMock: vi.fn(),
}))

// The production `whenFrontendBootstrapped` is a SHARED gate: every caller
// receives the same promise that resolves when the front-end bootstraps. The
// mock must mirror that — caching the FIRST call's promise across subsequent
// calls within the same override — otherwise a second gated inject (e.g.
// console-default + clear-console-filter both registered by
// rebuildDevtoolsHostView) overwrites the first call's `resolveGate` closure
// and strands it pending forever. `beforeEach` resets the cache.
let cachedGatePromise: Promise<boolean> | null = null

vi.mock('./frontend-bootstrap-gate.js', () => ({
  FRONTEND_BOOTSTRAP_PROBE_SCRIPT: '(() => false)()',
  whenFrontendBootstrapped: (wc: unknown) => {
    if (!cachedGatePromise) {
      cachedGatePromise = (whenFrontendBootstrappedMock(wc) as Promise<boolean> | undefined) ?? Promise.resolve(false)
    }
    return cachedGatePromise
  },
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
  cachedGatePromise = null
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
  it('does not inject the console-filter script before the bootstrap gate resolves', () => {
    const { ctx, emitServiceHostReady } = makeContext()
    const mgr = createViewManager(ctx)
    const service = makeServiceWc(701)

    mgr.attachNativeSimulator(SIM_URL, 375)
    const devtoolsWc = constructed[1]!.webContents
    emitServiceHostReady({ appId: 'gate', appSessionId: 's1', serviceWcId: service.id })

    const scripts = injectedScripts(devtoolsWc)
    expect(scripts.some((s) => s.includes('shouldBeVisible'))).toBe(false)
  })

  it('injects the console-filter script once the bootstrap gate resolves true', async () => {
    let resolveGate: (v: boolean) => void = () => {}
    whenFrontendBootstrappedMock.mockImplementation(() => new Promise<boolean>((resolve) => { resolveGate = resolve }))

    const { ctx, emitServiceHostReady } = makeContext()
    const mgr = createViewManager(ctx)
    const service = makeServiceWc(702)

    mgr.attachNativeSimulator(SIM_URL, 375)
    const devtoolsWc = constructed[1]!.webContents
    emitServiceHostReady({ appId: 'gate', appSessionId: 's1', serviceWcId: service.id })

    expect(
      injectedScripts(devtoolsWc).some((s) => s.includes('shouldBeVisible')),
      'must stay unapplied while the gate promise is still pending',
    ).toBe(false)

    resolveGate(true)
    await flushMicrotasks()

    const scripts = injectedScripts(devtoolsWc)
    const deNoiseScript = scripts.find((s) => s.includes('shouldBeVisible'))
    expect(deNoiseScript, 'the console de-noise script must eventually be injected').toBeTruthy()
    // The de-noise must never reach the developer's own filter input. Scoped
    // to the de-noise script itself — the clear-console-filter script is the
    // documented exception to that policy (see the developer-owned-controls
    // scan below) and legitimately contains textFilterUI.
    expect(deNoiseScript, 'the de-noise script must not mention the filter UI').not.toContain('textFilterUI')
  })

  it('never injects the console-filter script when the bootstrap gate resolves false (silent degradation)', async () => {
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

/**
 * Controls the DEVELOPER owns in the embedded front-end — the Console text
 * filter, the Network filter bar, Network's preserve-log / record toggles.
 * A script that sets one of these hands the developer a value they did not
 * type, cannot keep cleared (every re-point rewrites it, and "cleared" is
 * indistinguishable from "never set"), and in the case of the single-slot
 * text filters cannot use for their own filtering at all.
 *
 * Matching is on the front-end identifiers themselves, so it covers both the
 * live UI objects and the persisted setting names behind them.
 *
 * Scope and limits, so this is not read as more than it is:
 * - It scans what the VIEW MANAGER injects. `network-forward` and
 *   `elements-forward` also reach this wc, through `ctx.networkForward` /
 *   their own attach — neither is wired in this harness. Their payloads are
 *   `DevToolsAPI.dispatchMessage` CDP traffic and an outbound-CDP gate, which
 *   have no path to a panel control.
 * - It is a source scan, so it catches the plain call a regression would
 *   actually be written as, not a deliberately obfuscated one
 *   (`filter['text' + 'FilterUI']`). The runtime proof that the console
 *   de-noise leaves the box alone lives in console-filter.test.ts, which
 *   executes the real script against a spied `setValue`.
 */
const DEVELOPER_OWNED_CONTROLS: readonly RegExp[] = [
  /textFilterUI/,
  /console\.text-filter/,
  /network\.text-filter/,
  /filterBar/,
  /setFilterValue/,
  /preserveLogSetting/,
  /recordLogSetting/,
]

describe('developer-owned front-end controls', () => {
  it('no injection this view manager makes at the DevTools front-end host writes into one', async () => {
    whenFrontendBootstrappedMock.mockImplementation(() => Promise.resolve(true))

    const { ctx, emitServiceHostReady } = makeContext()
    const mgr = createViewManager(ctx)
    const service = makeServiceWc(705)

    mgr.attachNativeSimulator(SIM_URL, 375)
    const devtoolsWc = constructed[1]!.webContents
    emitServiceHostReady({ appId: 'gate', appSessionId: 's1', serviceWcId: service.id })

    // Let every gated injection land — the whole boot-time burst is under
    // test here, not one injection point.
    await flushMicrotasks()
    vi.advanceTimersByTime(5000)
    await flushMicrotasks()

    const scripts = injectedScripts(devtoolsWc)
    // Name the producers rather than counting: a refactor that stops firing one
    // of them would otherwise quietly shrink what this scan covers.
    for (const [producer, signature] of [
      ['tab customization', 'disable-locale-info-bar'],
      ['console de-noise', 'shouldBeVisible'],
      ['console default panel', "showView('console')"],
      // The clear-console-filter producer is the one intentional exception to
      // the developer-owned-controls policy below — clearing the STALE Console
      // filter leftover (the old filter-box implementation wrote a non-empty
      // value into the box, and DevTools' own setting persists it on disk; the
      // developer is not typing that value, we are removing it). It only ever
      // writes the EMPTY value, never a non-empty one.
      ['console filter stale-clear', "localStorage.removeItem('console.textFilter')"],
    ] as const) {
      expect(
        scripts.some((s) => s.includes(signature)),
        `the scan only means something while ${producer} is actually in it`,
      ).toBe(true)
    }

    // The clear-console-filter script is the documented exception: it removes
    // the stale persisted Console filter key (DevTools' own setting that the
    // developer did not type) and resets the visible box to empty. Exclude it
    // from the developer-owned-controls scan; every OTHER script is still
    // forbidden from touching these surfaces.
    const isStaleClearScript = (s: string): boolean =>
      s.includes("localStorage.removeItem('console.textFilter')")

    for (const script of scripts) {
      if (isStaleClearScript(script)) continue
      for (const control of DEVELOPER_OWNED_CONTROLS) {
        expect(
          control.test(script),
          `an injected script writes the developer-owned control ${control.source}: ${script.slice(0, 160)}`,
        ).toBe(false)
      }
    }
  })
})
