/**
 * Simulator-DevTools host: re-point onto a swapped service-host wc must reuse
 * the DevTools front-end host WITHOUT calling `setDevToolsWebContents` on it a
 * second time.
 *
 * Contract (Electron): `webContents.setDevToolsWebContents(hostWc)` requires
 * `hostWc` to have NEVER navigated. `pointNativeDevtoolsAtServiceWc` (view-
 * manager.ts ~1187) points the right-panel DevTools front-end host
 * (`simulatorView.webContents`) at the SERVICE-HOST wc (`next`) via
 * `next.setDevToolsWebContents(simulatorView.webContents)` +
 * `next.openDevTools({mode:'detach', activate:false})`. The first point loads
 * the DevTools front-end into that host wc — a navigation. When the
 * pre-warm pool swaps the service-host wc (`ctx.bridge.getServiceWc()` returns
 * a wc with a different `id`), `onNativeRenderEvent` →
 * `followNativeDevtoolsServiceHost` → `pointNativeDevtoolsAtActiveServiceHost`
 * re-invoke `pointNativeDevtoolsAtServiceWc` on the SAME, already-navigated
 * `simulatorView.webContents`.
 *
 * Bug this guards against: a second `setDevToolsWebContents` +
 * `openDevTools({mode:'detach'})` on the same already-navigated host wc
 * violates Electron's contract — the custom host stops being honoured and
 * Chrome DevTools tears out into an independent floating window instead of
 * staying embedded in the right panel.
 *
 * Fixed contract: the DevTools front-end host is a one-shot resource per
 * service-wc generation. Re-pointing to a new service wc (pool swap) must
 * REBUILD the host (`simulatorView`) — a fresh, never-navigated
 * `WebContentsView` — rather than calling `setDevToolsWebContents` again on
 * the wc that already hosted a previous generation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RenderEvent } from '../../ipc/bridge-router.js'

// ── electron stub ───────────────────────────────────────────────────────────
// Tracks every WebContentsView ever constructed (construction order:
// attachNativeSimulator builds [0] = the native simulator content view, then
// attachNativeSimulatorDevtoolsHost builds [1] = the DevTools front-end host
// view — same ordering documented in the sibling max-listeners/anchor-only
// tests).
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
        // DevTools front-end host wc surface (this stub is used for
        // `simulatorView.webContents`, i.e. the right-panel DevTools host).
        isLoading: vi.fn(() => false),
        executeJavaScript: vi.fn(() => Promise.resolve()),
        setDevToolsWebContents: vi.fn(),
        openDevTools: vi.fn(),
        isDevToolsOpened: vi.fn(() => false),
        closeDevTools: vi.fn(),
        getURL: vi.fn(() => ''),
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
      fromId: vi.fn(() => undefined),
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

// Import AFTER mocks so view-manager picks up the stubs.
import { createViewManager } from './view-manager.js'
import { simulatorDevtoolsBounds } from './placement-test-driver.js'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

const SIM_URL = 'http://localhost:7788/simulator.html?appId=repoint'

/** A hidden SERVICE-HOST BrowserWindow wc (top-level, can host DevTools). */
function makeServiceWc(id: number): StubWebContents {
  return {
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
    executeJavaScript: vi.fn(() => Promise.resolve()),
    setDevToolsWebContents: vi.fn(),
    openDevTools: vi.fn(),
    isDevToolsOpened: vi.fn(() => true),
    closeDevTools: vi.fn(),
    getURL: vi.fn(() => ''),
  }
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

  // ── ctx.bridge stub ───────────────────────────────────────────────────────
  // Minimal `BridgeRouterHandle`: `getServiceWc` resolves to whatever the test
  // currently points `currentServiceWc` at (simulating a pre-warm-pool swap
  // between render events), and `onRenderEvent` fans a manually-driven
  // `RenderEvent` out to every subscriber (view-manager's own follow-path AND
  // elements-forward's internal subscription both register here).
  let currentServiceWc: StubWebContents | null = null
  const renderEventListeners = new Set<(event: RenderEvent) => void>()
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
    getDevice: () => null,
    setDevice: () => {},
    disposeSessionsForSimulator: () => Promise.resolve(),
  }

  function setActiveServiceWc(wc: StubWebContents): void {
    currentServiceWc = wc
  }
  function emitRenderEvent(event: RenderEvent): void {
    for (const l of [...renderEventListeners]) l(event)
  }

  return {
    addChildView,
    removeChildView,
    setActiveServiceWc,
    emitRenderEvent,
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

beforeEach(() => {
  constructed.length = 0
  // elements-forward installs a 150ms self-healing reconcile `setInterval`
  // (drain outbound queue / re-assert the front-end hook) on every DevTools
  // host attach. Fake timers keep it from ever actually firing mid-test —
  // every callback in it is best-effort/guarded, but there is no reason to pay
  // for a live timer in a synchronous assertion test.
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** All addChildView calls that targeted `view`. */
function addsOf(addChildView: ReturnType<typeof vi.fn>, view: StubView): unknown[][] {
  return addChildView.mock.calls.filter((c) => c[0] === view)
}

describe('DevTools front-end host wc: one-shot setDevToolsWebContents across service-wc pool swaps', () => {
  it('never calls setDevToolsWebContents twice on the same DevTools host wc across ≥2 service-wc swaps', () => {
    const { ctx, setActiveServiceWc, emitRenderEvent } = makeContext()
    const mgr = createViewManager(ctx)

    const serviceA = makeServiceWc(101)
    const serviceB = makeServiceWc(102)
    const serviceC = makeServiceWc(103)
    setActiveServiceWc(serviceA)

    mgr.attachNativeSimulator(SIM_URL, 375)

    // [0] = native simulator content view, [1] = DevTools front-end host view.
    expect(constructed.length).toBeGreaterThanOrEqual(2)

    // First point: attachNativeSimulator already resolves+points at the active
    // service host (serviceA) via followNativeDevtoolsServiceHost().
    expect(serviceA.setDevToolsWebContents).toHaveBeenCalledTimes(1)

    // Pool swap #1: a render event arrives naming a NEW service-host wc.
    setActiveServiceWc(serviceB)
    emitRenderEvent({ kind: 'activePage', appId: 'repoint', bridgeId: 'b1' })

    // Pool swap #2: another render event names YET ANOTHER service-host wc.
    setActiveServiceWc(serviceC)
    emitRenderEvent({ kind: 'domReady', appId: 'repoint', bridgeId: 'b2' })

    // `setDevToolsWebContents` is called ON the service wc, with the DevTools
    // front-end HOST wc (`simulatorView.webContents`) as its ARGUMENT. Collect
    // every (targetHostWc) argument across all three service wc's calls and
    // assert no single host wc instance is ever targeted more than once —
    // Electron's contract forbids re-pointing devtools at an already-navigated
    // host; a host wc appearing as the argument twice IS the bug (the custom
    // host stops being honoured and DevTools tears out into an independent
    // floating window on the second call).
    const targetedHostCounts = new Map<unknown, number>()
    for (const serviceWc of [serviceA, serviceB, serviceC]) {
      for (const call of serviceWc.setDevToolsWebContents.mock.calls) {
        const target = call[0]
        targetedHostCounts.set(target, (targetedHostCounts.get(target) ?? 0) + 1)
      }
    }
    for (const [target, count] of targetedHostCounts) {
      const hostId = (target as StubWebContents | undefined)?.id
      expect(
        count,
        `DevTools front-end host wc #${hostId} was passed to setDevToolsWebContents ${count} times — Electron forbids re-pointing devtools at an already-navigated host wc`,
      ).toBeLessThanOrEqual(1)
    }

    // Each of the THREE distinct service-host wc's was pointed at devtools
    // exactly once (once per swap) — the swaps did drive re-pointing.
    expect(serviceA.setDevToolsWebContents).toHaveBeenCalledTimes(1)
    expect(serviceB.setDevToolsWebContents).toHaveBeenCalledTimes(1)
    expect(serviceC.setDevToolsWebContents).toHaveBeenCalledTimes(1)

    // The fixed contract additionally requires the HOST to be rebuilt (a new,
    // never-navigated WebContentsView) on each re-point rather than reused —
    // i.e. at least 3 distinct DevTools-host-shaped views should have been
    // constructed (native simulator view + one host per generation).
    expect(
      constructed.length,
      'each service-wc swap must rebuild a fresh (never-navigated) DevTools front-end host view instead of reusing the one that already hosted a previous generation',
    ).toBeGreaterThanOrEqual(4) // 1 native simulator view + 3 devtools host generations
  })
})

describe('DevTools front-end host view: the rebuilt host is re-attached to contentView', () => {
  it('re-attaches the rebuilt DevTools host view after a service-wc swap triggers rebuildDevtoolsHostView', () => {
    // Guards `removeSimulatorDevtoolsView`'s
    // `placementState.actual.delete(VIEW_ID.simulatorDevtools)` (view-manager.ts):
    // `rebuildDevtoolsHostView` manually `removeChildView`s the outgoing host —
    // bypassing the level-triggered reconciler's own `detach` op — then builds a
    // fresh `WebContentsView` for the new host. The reconciler's
    // `placementState.actual` map is the single source of truth for "is
    // VIEW_ID.simulatorDevtools currently attached"; if the rebuild does not
    // also forget that record, the next `reconcileNow()` (fired at the end of
    // `rebuildDevtoolsHostView`) still believes the (now-destroyed) old host is
    // attached, never emits an `attach` op for the rebuilt host, and
    // `addChildView` is never called on it — embedded but invisible, mirroring
    // the simulator-view relaunch bug.
    const { ctx, addChildView, setActiveServiceWc, emitRenderEvent } = makeContext()
    const mgr = createViewManager(ctx)

    const serviceA = makeServiceWc(301)
    const serviceB = makeServiceWc(302)
    setActiveServiceWc(serviceA)

    mgr.attachNativeSimulator(SIM_URL, 375)
    // [0] = native simulator content view, [1] = the first DevTools host view.
    expect(constructed.length).toBeGreaterThanOrEqual(2)
    const firstDevtoolsHost = constructed[1]!

    // Publish a non-zero rect for the devtools panel: the level-triggered
    // reconciler attaches (addChildView) the first DevTools host view.
    simulatorDevtoolsBounds(mgr, { x: 400, y: 0, width: 400, height: 812 })
    expect(
      addsOf(addChildView, firstDevtoolsHost).length,
      'the first DevTools host view must mount once a non-zero rect is published',
    ).toBe(1)

    // Pool swap: a render event names a NEW service-host wc. `devtoolsHostUsed`
    // is already true from the point above, so `pointNativeDevtoolsAtServiceWc`
    // rebuilds the host (`rebuildDevtoolsHostView`) instead of re-pointing the
    // same one. Nothing re-publishes a fresh placement for
    // `simulatorDevtools` around this swap — the level-triggered `baseDesired`
    // table simply carries the prior (visible) value forward, mirroring the
    // simulator relaunch case in the sibling test file.
    setActiveServiceWc(serviceB)
    emitRenderEvent({ kind: 'activePage', appId: 'repoint', bridgeId: 'b1' })

    expect(
      constructed.length,
      'the service-wc swap must rebuild a fresh DevTools host view',
    ).toBe(3)
    const rebuiltDevtoolsHost = constructed[2]!
    expect(rebuiltDevtoolsHost).not.toBe(firstDevtoolsHost)

    expect(
      addsOf(addChildView, rebuiltDevtoolsHost).length,
      'the rebuilt DevTools host view must be re-attached to contentView — the reconciler must not still believe the destroyed outgoing host is attached',
    ).toBe(1)
  })
})
