/**
 * Regression tests for the bridge-router's SIMULATOR-WCV-DESTROYED teardown
 * path (the `simulatorWc.once('destroyed', …)` hook installed by handleSpawn).
 *
 * ── The contract being pinned ───────────────────────────────────────────────
 * The simulator WCV owns the app's UI lifetime. When it is destroyed (project
 * close / DeviceShell respawn on hot reload) the guest never gets to send its
 * graceful `C.DISPOSE`, so the router's destroyed hook must perform the SAME
 * full teardown the graceful path performs:
 *
 *   1. App session gone + hidden service-host window closed + the app's
 *      ACCUMULATED APPDATA BRIDGE ENTRIES EVICTED (`ctx.appData`). Both the
 *      graceful `C.DISPOSE` handler and the destroyed hook funnel into
 *      `disposeAppSession`, the SINGLE eviction chokepoint — it runs
 *      `state.evictAppDataBridges(ap)` before page teardown, evicting every
 *      page bridge from the AppData accumulator. Without that eviction a
 *      respawn would leave ghost tabs from the dead session in the AppData
 *      panel — the eviction assertions below pin the chokepoint.
 *      (Comment updated to the centralized-chokepoint implementation; an
 *      earlier revision described eviction as inlined in onDispose with
 *      disposeAppSession never touching ctx.appData, which no longer holds.)
 *
 *   2. 'destroyed' and a graceful `C.DISPOSE` racing in the same tick must not
 *      double-run teardown side effects (close the service window twice, …).
 *
 *   3. After S1's simulator WCV dies and S2 respawns with the SAME appId,
 *      `resolveCurrentApp` (via `ctx.bridge.getServiceWc` /
 *      `getActiveBridgeId`) resolves S2 — even while a stale same-appId
 *      session still lingers mid-teardown (most-recent-spawn-wins).
 *
 *   4. App-teardown LIFO benign-order pin: the connection registry runs its
 *      dispose callbacks LIFO, so the `context.appData = undefined` setter
 *      (app/app.ts) can run BEFORE the router's per-session
 *      `disposeAppSession` sweep. The eviction hook's `if (!ctx.appData)
 *      return` guard makes that order benign — no throw, and the rest of the
 *      session teardown (window close, session removal) still completes. The
 *      AppData service is gone wholesale at that point, so there is no live
 *      accumulator to hold ghost entries.
 *
 * Seam: the REAL `installBridgeRouter` driven through its real IPC emitters
 * (SPAWN → SERVICE_PUBLISH → DISPOSE) under an exhaustive electron mock (same
 * pattern as bridge-router-connection-reset.test.ts), pooling OFF so spawns
 * take the fresh-window path, and the REAL `setupSimulatorAppData` service as
 * `ctx.appData` — the AppData bridge registry the graceful path evicts is the
 * real accumulator, seeded through the router's own SERVICE_PUBLISH tap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

// ── Hoisted electron stub state ─────────────────────────────────────────────
const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  /** ipcMain.on listeners: channel → set of fns. */
  const onListeners = new Map<string, Set<AnyFn>>()
  /** ipcMain.handle handlers: channel → fn. */
  const invokeHandlers = new Map<string, AnyFn>()

  function makeEmitter() {
    const listeners: EventBag = {}
    const api = {
      listeners,
      on(event: string, fn: AnyFn) { (listeners[event] ??= new Set()).add(fn); return api },
      once(event: string, fn: AnyFn) {
        const wrap: AnyFn = (...a: unknown[]) => { listeners[event]?.delete(wrap); return fn(...a) }
        ;(listeners[event] ??= new Set()).add(wrap); return api
      },
      off(event: string, fn: AnyFn) { listeners[event]?.delete(fn); return api },
      removeListener(event: string, fn: AnyFn) { listeners[event]?.delete(fn); return api },
      emit(event: string, ...a: unknown[]) { for (const fn of [...(listeners[event] ?? [])]) fn(...a) },
    }
    return api
  }

  let nextWcId = 3000
  /** Every mock webContents created, by id — resolves the service window's wc
   * from the `serviceWcId` a spawn returns. */
  const wcById = new Map<number, ReturnType<typeof makeWebContents>>()
  function makeWebContents() {
    const em = makeEmitter()
    const sent: Array<{ channel: string; payload: unknown }> = []
    const wc = {
      ...em,
      id: nextWcId++,
      destroyed: false,
      isDestroyed() { return this.destroyed },
      getURL: () => 'file:///service.html',
      getType: () => 'window',
      send: vi.fn((channel: string, payload: unknown) => { sent.push({ channel, payload }) }),
      executeJavaScript: vi.fn(() => Promise.resolve(undefined)),
      openDevTools: vi.fn(),
      sentMessages: sent,
    }
    wcById.set(wc.id, wc)
    return wc
  }

  /** Service-host BrowserWindow mock. NOTE: `close()` does NOT flip
   * `destroyed` synchronously — real Electron destruction is async (same-tick
   * `isDestroyed()` after `close()` is still false), so same-tick idempotency
   * must come from the router's own session bookkeeping, not the window flag. */
  function makeBrowserWindow() {
    const em = makeEmitter()
    const win = {
      ...em,
      webContents: makeWebContents(),
      destroyed: false,
      isDestroyed() { return this.destroyed },
      close: vi.fn(),
      loadURL: vi.fn(() => Promise.resolve()),
      loadFile: vi.fn(() => Promise.resolve()),
    }
    return win
  }

  /** Windows handed out by the mocked createServiceHostWindow, in spawn order. */
  const createdWindows: Array<ReturnType<typeof makeBrowserWindow>> = []
  function createWindowForSpawn() {
    const win = makeBrowserWindow()
    createdWindows.push(win)
    return win
  }

  function reset() {
    onListeners.clear()
    invokeHandlers.clear()
    wcById.clear()
    createdWindows.length = 0
    nextWcId = 3000
  }

  return {
    onListeners, invokeHandlers, wcById, createdWindows,
    makeEmitter, makeWebContents, makeBrowserWindow, createWindowForSpawn,
    reset,
  }
})

vi.mock('electron', () => {
  type AnyFn = (...args: unknown[]) => unknown

  const ipcMain = {
    on: vi.fn((channel: string, fn: AnyFn) => {
      ;(stubs.onListeners.get(channel) ?? stubs.onListeners.set(channel, new Set()).get(channel)!).add(fn)
    }),
    removeListener: vi.fn((channel: string, fn: AnyFn) => {
      stubs.onListeners.get(channel)?.delete(fn)
    }),
    handle: vi.fn((channel: string, fn: AnyFn) => { stubs.invokeHandlers.set(channel, fn) }),
    removeHandler: vi.fn((channel: string) => { stubs.invokeHandlers.delete(channel) }),
  }

  const protocolStub = { handle: vi.fn(), unhandle: vi.fn(), registerSchemesAsPrivileged: vi.fn() }
  const sessionStub = {
    fromPartition: vi.fn(() => ({
      webRequest: { onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() },
      registerPreloadScript: vi.fn(),
      protocol: { handle: vi.fn(), unhandle: vi.fn() },
    })),
    defaultSession: { protocol: { handle: vi.fn(), unhandle: vi.fn() } },
  }

  return {
    ipcMain,
    app: { isPackaged: true, getLocale: () => 'en-US', getPath: vi.fn(() => '/tmp/dimina-test-userdata') },
    BrowserWindow: class {},
    WebContentsView: class { webContents = {}; setBounds = vi.fn(); setBackgroundColor = vi.fn() },
    protocol: protocolStub,
    session: sessionStub,
    webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
    nativeTheme: { themeSource: 'system', on: vi.fn() },
    default: {},
  }
})

// Stub the service-host window-creation module: pooling is OFF in this suite,
// so every spawn goes through createServiceHostWindow (recorded for close()
// assertions). `serviceHostSpec` is read at install time.
vi.mock('../windows/service-host-window/create.js', () => ({
  serviceHostSpec: () => ({}),
  serviceHostPreloadPath: '/tmp/preload.cjs',
  SERVICE_HOST_PARTITION: 'persist:simulator',
  buildServiceHostSpawnUrl: () => 'file:///service.html',
  navigateServiceHost: vi.fn(() => Promise.resolve()),
  createServiceHostWindow: vi.fn(() => stubs.createWindowForSpawn()),
  constructServiceHostWindow: vi.fn(() => stubs.createWindowForSpawn()),
}))

import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type {
  DisposePayload,
  ServicePublishPayload,
  SpawnRequest,
  SpawnResult,
} from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { SimulatorAppDataService } from '../services/simulator-appdata/index.js'

type AnyFn = (...args: unknown[]) => unknown
type MockWc = ReturnType<typeof stubs.makeWebContents>
type MockWin = ReturnType<typeof stubs.makeBrowserWindow>

const APP_ID = 'demo-app'

let installBridgeRouter: typeof import('./bridge-router.js').installBridgeRouter
let setupSimulatorAppData: typeof import('../services/simulator-appdata/index.js').setupSimulatorAppData

const PRIOR_POOL_ENV = process.env.DIMINA_PREWARM_POOL_SIZE
const PRIOR_DISABLE_ENV = process.env.DIMINA_PREWARM_DISABLE

beforeEach(async () => {
  // Pooling OFF: the destroyed-path teardown under test runs the fresh-window
  // branch of disposeAppSession (service window CLOSED, not pooled).
  delete process.env.DIMINA_PREWARM_POOL_SIZE
  delete process.env.DIMINA_PREWARM_DISABLE
  vi.resetModules()
  stubs.reset()
  ;({ installBridgeRouter } = await import('./bridge-router.js'))
  ;({ setupSimulatorAppData } = await import('../services/simulator-appdata/index.js'))
})

afterEach(() => {
  if (PRIOR_POOL_ENV === undefined) delete process.env.DIMINA_PREWARM_POOL_SIZE
  else process.env.DIMINA_PREWARM_POOL_SIZE = PRIOR_POOL_ENV
  if (PRIOR_DISABLE_ENV === undefined) delete process.env.DIMINA_PREWARM_DISABLE
  else process.env.DIMINA_PREWARM_DISABLE = PRIOR_DISABLE_ENV
})

/** Fire an `ipcMain.on` channel as if a renderer/webview sent it. */
function emitOn(channel: string, sender: unknown, payload: unknown): void {
  const fns = stubs.onListeners.get(channel)
  if (!fns) throw new Error(`no ipcMain.on listener for ${channel}`)
  for (const fn of [...fns]) fn({ sender }, payload)
}

/** Build the minimal WorkbenchContext the bridge-router reads, with a REAL
 *  connection registry and the REAL AppData service (the bridge registry the
 *  graceful dispose path evicts). */
function makeCtx(): {
  ctx: WorkbenchContext
  simulatorWc: MockWc
  appData: SimulatorAppDataService
} {
  const simulatorWc = stubs.makeWebContents()
  const appDataHostWc = stubs.makeWebContents()
  const appData = setupSimulatorAppData(
    appDataHostWc as never,
    { getActiveAppId: () => APP_ID },
  )
  const ctx = {
    registry: { add: (_fn: AnyFn) => {} },
    simulatorApis: { has: (_name: string) => false, invoke: async () => ({}) },
    windows: { mainWindow: { webContents: simulatorWc } },
    workspace: { getSession: () => undefined },
    connections: createConnectionRegistry(),
    appData,
  } as unknown as WorkbenchContext
  return { ctx, simulatorWc, appData }
}

/** Spawn an app session FROM a given simulator wc (the sender) and return the
 *  spawn result + the mock service-host window/wc behind it. */
async function spawnSession(simulatorWc: MockWc): Promise<{
  result: SpawnResult
  serviceWc: MockWc
  serviceWindow: MockWin
}> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  const req: SpawnRequest = {
    appId: APP_ID,
    pagePath: 'pages/index/index',
    // Supply a resourceBaseUrl so handleSpawn skips startDiminaResourceServer.
    resourceBaseUrl: 'http://127.0.0.1:1/',
  }
  const result = (await (handle as AnyFn)({ sender: simulatorWc }, req)) as SpawnResult
  const serviceWc = stubs.wcById.get(result.serviceWcId) as MockWc | undefined
  if (!serviceWc) throw new Error(`no mock webContents with id ${result.serviceWcId}`)
  const serviceWindow = stubs.createdWindows.find(w => w.webContents.id === result.serviceWcId)
  if (!serviceWindow) throw new Error('spawned service window not found among created windows')
  return { result, serviceWc, serviceWindow }
}

/** Seed the app's AppData bridge registry THROUGH the router: a `page_*` init
 *  message on SERVICE_PUBLISH registers the page bridge in the accumulator —
 *  the exact entries the graceful C.DISPOSE path evicts via
 *  `ctx.appData.evictBridge(appId, page.bridgeId)`. */
function seedAppData(serviceWc: MockWc, bridgeId: string): void {
  const payload: ServicePublishPayload = {
    bridgeId,
    msg: {
      type: `page_${bridgeId}`,
      target: 'render',
      body: { bridgeId, path: 'pages/index/index', data: { hello: 'world' } },
    },
  }
  emitOn(C.SERVICE_PUBLISH, serviceWc, payload)
}

/** The seeded bridge ids currently registered for the app in AppData. */
function appDataBridgeIds(appData: SimulatorAppDataService): string[] {
  const snap = appData.snapshot!(APP_ID) as { bridges: Array<{ id: string }> }
  return snap.bridges.map(b => b.id)
}

/** Mark a mock wc destroyed and fire its 'destroyed' event (real Electron
 *  semantics: by the time 'destroyed' listeners run, isDestroyed() is true). */
function destroyWc(wc: MockWc): void {
  wc.destroyed = true
  wc.emit('destroyed')
}

/** Flush the microtask queue (disposeAppSession is async). */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('bridge-router — simulator WCV destroyed teardown parity with graceful DISPOSE', () => {
  it('baseline: graceful C.DISPOSE evicts the app\'s AppData bridge entries (sanity for the seeding seam)', async () => {
    const { ctx, simulatorWc, appData } = makeCtx()
    installBridgeRouter(ctx)
    const { result, serviceWc } = await spawnSession(simulatorWc)

    seedAppData(serviceWc, result.bridgeId)
    // Guard: the seed must land, otherwise the RED test below would be vacuous.
    expect(appDataBridgeIds(appData), 'seeding via SERVICE_PUBLISH must register the bridge').toContain(result.bridgeId)

    emitOn(C.DISPOSE, serviceWc, { bridgeId: result.bridgeId } satisfies DisposePayload)
    await flush()

    expect(
      appDataBridgeIds(appData),
      'graceful DISPOSE must evict the app\'s AppData bridge entries',
    ).toEqual([])
  })

  it('(1) simulator WC destroyed → app session, service-host window AND AppData bridge entries are cleaned up', async () => {
    const { ctx, simulatorWc, appData } = makeCtx()
    installBridgeRouter(ctx)
    const { result, serviceWc, serviceWindow } = await spawnSession(simulatorWc)

    seedAppData(serviceWc, result.bridgeId)
    expect(appDataBridgeIds(appData), 'seeding via SERVICE_PUBLISH must register the bridge').toContain(result.bridgeId)

    destroyWc(simulatorWc)
    await flush()

    // Session torn down: the hidden service-host window is closed…
    expect(serviceWindow.close, 'destroyed path must close the service-host window').toHaveBeenCalledTimes(1)
    // …and the session is no longer resolvable for the app.
    expect(
      ctx.bridge!.getServiceWc(APP_ID),
      'destroyed path must remove the app session (no stale resolution)',
    ).toBeNull()

    // THE REGRESSION: the destroyed path must perform the SAME AppData bridge
    // eviction the graceful C.DISPOSE path performs — otherwise the panel keeps
    // ghost tabs from the dead session after a respawn.
    expect(
      appDataBridgeIds(appData),
      'destroyed path must evict the app\'s AppData bridge entries (parity with graceful DISPOSE)',
    ).toEqual([])
  })

  it('(2) same-tick \'destroyed\' + graceful C.DISPOSE double-fire runs teardown side effects exactly once', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const { result, serviceWc, serviceWindow } = await spawnSession(simulatorWc)

    // Same tick, no flush in between: the hot-reload respawn race.
    destroyWc(simulatorWc)
    emitOn(C.DISPOSE, serviceWc, { bridgeId: result.bridgeId } satisfies DisposePayload)
    await flush()

    expect(
      serviceWindow.close,
      'double-fired teardown must close the service-host window exactly once',
    ).toHaveBeenCalledTimes(1)
  })

  it('(3) respawn with the same appId resolves the NEWEST session, before and after the old simulator WC dies', async () => {
    const { ctx } = makeCtx()
    installBridgeRouter(ctx)

    const simWc1 = stubs.makeWebContents()
    const simWc2 = stubs.makeWebContents()
    const s1 = await spawnSession(simWc1)
    const s2 = await spawnSession(simWc2)

    // While the superseded S1 still lingers mid-teardown, same-appId resolution
    // must already prefer the MOST RECENT spawn (S2), not the first match.
    expect(
      ctx.bridge!.getServiceWc(APP_ID)?.id,
      'with a stale same-appId session present, resolution must prefer the newest spawn',
    ).toBe(s2.result.serviceWcId)
    expect(
      ctx.bridge!.getActiveBridgeId(APP_ID),
      'active bridge must resolve to the newest session\'s root bridge',
    ).toBe(s2.result.bridgeId)

    // S1's simulator WCV dies (the respawn completing) → still resolves S2.
    destroyWc(simWc1)
    await flush()

    expect(s1.serviceWindow.close, 'S1 teardown must close S1\'s service window').toHaveBeenCalledTimes(1)
    expect(s2.serviceWindow.close, 'S1 teardown must not touch S2\'s service window').not.toHaveBeenCalled()
    expect(
      ctx.bridge!.getServiceWc(APP_ID)?.id,
      'after the old simulator WC dies, resolution must still point at S2',
    ).toBe(s2.result.serviceWcId)
    expect(ctx.bridge!.getActiveBridgeId(APP_ID)).toBe(s2.result.bridgeId)
  })

  it('(4) app-teardown LIFO: ctx.appData already undefined when teardown fires → no throw, session still fully cleaned up', async () => {
    const { ctx, simulatorWc, appData } = makeCtx()
    installBridgeRouter(ctx)
    const { result, serviceWc, serviceWindow } = await spawnSession(simulatorWc)

    // A live session with a registered page bridge (so the eviction loop has
    // entries it WOULD walk if the guard were missing).
    seedAppData(serviceWc, result.bridgeId)
    expect(appDataBridgeIds(appData), 'seeding via SERVICE_PUBLISH must register the bridge').toContain(result.bridgeId)

    // App teardown LIFO (electron-deck connection registry): the AppData
    // service's `context.appData = undefined` setter (app/app.ts) has already
    // run by the time the router's disposeAppSession sweep fires.
    ;(ctx as { appData?: SimulatorAppDataService }).appData = undefined

    // Trigger disposeAppSession via the destroyed hook. If the eviction hook's
    // `if (!ctx.appData) return` guard were missing, `ctx.appData.evictBridge`
    // would throw on undefined BEFORE the window close / session removal below
    // — those assertions are the throw detector (the async dispose swallows
    // synchronous propagation).
    destroyWc(simulatorWc)
    await flush()

    expect(
      serviceWindow.close,
      'teardown with appData already gone must still close the service-host window',
    ).toHaveBeenCalledTimes(1)
    expect(
      ctx.bridge!.getServiceWc(APP_ID),
      'teardown with appData already gone must still remove the app session',
    ).toBeNull()
  })
})
