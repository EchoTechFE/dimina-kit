/**
 * Behavior tests for the bridge-router's CONNECTION-LAYER wiring of the
 * service-host webContents (foundation.md §4.3 + §9 P1 DoD#4 + §10).
 *
 * ── The contract being pinned (implemented + verified) ──────────────────────
 * The bridge-router tracks every service-host webContents through the
 * connection registry (`ctx.connections`, a real `ConnectionRegistry` from
 * `@dimina-kit/workbench/main`) and, on POOLED service-host REUSE, RESET that
 * connection so an old app session's per-wc bookkeeping cannot bleed into the
 * next session that reuses the same webContents:
 *
 *   1. After a spawn creates an app session, `ctx.connections.get(serviceWc.id)`
 *      returns a LIVE connection for the service-host webContents.
 *
 *   2. When that session is disposed on the POOL-REUSE path (the pooled window
 *      is returned to the pool, NOT destroyed), `ctx.connections.reset(id)` is
 *      invoked: the connection stays ALIVE (it is reused) but its previous
 *      lifetime segment is disposed — a resource `own()`-ed during the session
 *      is torn down — and a `'reset'` event fires.
 *
 *   3. The connection-routed per-serviceWc bookkeeping (the
 *      `serviceWc -> appSessionId` binding in `state.wcIdToAppSessionId`) is
 *      cleared by the reset, so the next session reusing the same wc starts
 *      clean.
 *
 * ── How this is implemented ─────────────────────────────────────────────────
 * The bridge-router acquires a connection for the RENDER guest
 * (`ensureRenderBound`) AND for the service-host webContents — the spawn binds
 * `state.wcIdToAppSessionId` and calls
 * `state.connections.acquire(serviceWindow.webContents)`, so assertion (1)
 * (a live connection tracked after spawn) holds. On the pool-reuse dispose path,
 * `disposeAppSession` calls `state.connections.reset(id)`, driving (2)/(3).
 * These are green regression tests guarding that wiring against regressions.
 *
 * Seam: the REAL `installBridgeRouter` is driven through its real IPC emitters
 * (SPAWN → DISPOSE) under an exhaustive electron mock + a controllable fake
 * `ServiceHostPool` (so the pool-reuse dispose branch runs without constructing
 * real BrowserWindows). The connection registry is the REAL one, so
 * `own()`/`reset()`/`'reset'` are real and observable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConnectionRegistry } from '@dimina-kit/workbench/main'

// ── Hoisted electron + pool stub state ──────────────────────────────────────
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

  let nextWcId = 2000
  /** Every mock webContents created, by id — lets a test resolve the service
   * window from the `serviceWcId` a spawn returns. */
  const wcById = new Map<number, ReturnType<typeof makeWebContents>>()
  /** A mock WebContents: a real emitter (id/once/on/emit/isDestroyed) so the
   * connection's `wc.once('destroyed')` hook works and reset/close are
   * observable; also records `send(channel, payload)`. */
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

  function makeBrowserWindow() {
    const em = makeEmitter()
    const win = {
      ...em,
      webContents: makeWebContents(),
      destroyed: false,
      isDestroyed() { return this.destroyed },
      close: vi.fn(function (this: { destroyed: boolean }) { this.destroyed = true }),
      loadURL: vi.fn(() => Promise.resolve()),
      loadFile: vi.fn(() => Promise.resolve()),
    }
    return win
  }

  // ── Controllable fake ServiceHostPool ────────────────────────────────────
  /** Records of `release(entryId, win)` calls — the pool-reuse signal. */
  const releaseCalls: Array<{ entryId: string; win: unknown }> = []
  /** Records of `releaseDestroyed(entryId)` calls. */
  const releaseDestroyedCalls: string[] = []
  /** Windows the fake pool handed out, by entryId. */
  const acquiredByEntryId = new Map<string, ReturnType<typeof makeBrowserWindow>>()
  let nextEntryId = 1

  class FakeServiceHostPool {
    async init(): Promise<void> { /* no warm windows in unit test */ }
    async acquire(): Promise<{ win: unknown; entryId: string }> {
      const win = makeBrowserWindow()
      const entryId = `entry-${nextEntryId++}`
      acquiredByEntryId.set(entryId, win)
      return { win, entryId }
    }
    async release(entryId: string, win: unknown): Promise<void> {
      // Pool-reuse: the window is returned to the pool, NOT destroyed.
      releaseCalls.push({ entryId, win })
    }
    releaseDestroyed(entryId: string): void {
      releaseDestroyedCalls.push(entryId)
    }
    dispose(): void { /* noop */ }
  }

  function reset() {
    onListeners.clear()
    invokeHandlers.clear()
    wcById.clear()
    releaseCalls.length = 0
    releaseDestroyedCalls.length = 0
    acquiredByEntryId.clear()
    nextWcId = 2000
    nextEntryId = 1
  }

  return {
    onListeners, invokeHandlers, wcById,
    makeEmitter, makeWebContents, makeBrowserWindow,
    FakeServiceHostPool, releaseCalls, releaseDestroyedCalls, acquiredByEntryId,
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

// Stub the service-host window-creation module (the fresh path); the pooled
// path goes through the fake pool below, so these are only used if pooling is
// off. `serviceHostSpec` is read by the pool wiring at install time.
vi.mock('../windows/service-host-window/create.js', () => ({
  serviceHostSpec: () => ({}),
  serviceHostPreloadPath: '/tmp/preload.cjs',
  SERVICE_HOST_PARTITION: 'persist:simulator',
  buildServiceHostSpawnUrl: () => 'file:///service.html',
  navigateServiceHost: vi.fn(() => Promise.resolve()),
  createServiceHostWindow: vi.fn(() => stubs.makeBrowserWindow()),
  constructServiceHostWindow: vi.fn(() => stubs.makeBrowserWindow()),
}))

// Replace the real ServiceHostPool with the controllable fake so the
// pool-reuse dispose branch runs without constructing real BrowserWindows.
vi.mock('../services/service-host-pool/pool.js', () => ({
  ServiceHostPool: stubs.FakeServiceHostPool,
}))

import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type { DisposePayload, SpawnRequest, SpawnResult } from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'

type AnyFn = (...args: unknown[]) => unknown
type MockWc = ReturnType<typeof stubs.makeWebContents>

let installBridgeRouter: typeof import('./bridge-router.js').installBridgeRouter

const PRIOR_POOL_ENV = process.env.DIMINA_PREWARM_POOL_SIZE
const PRIOR_DISABLE_ENV = process.env.DIMINA_PREWARM_DISABLE

beforeEach(async () => {
  // Enable the pre-warm pool so handleSpawn takes the pooled path
  // (poolEntryId !== null) and disposeAppSession runs its pool-reuse branch.
  process.env.DIMINA_PREWARM_POOL_SIZE = '1'
  delete process.env.DIMINA_PREWARM_DISABLE
  vi.resetModules()
  stubs.reset()
  vi.useFakeTimers()
  ;({ installBridgeRouter } = await import('./bridge-router.js'))
})

afterEach(() => {
  vi.useRealTimers()
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

/** Build the minimal WorkbenchContext the bridge-router actually reads, with a
 *  REAL connection registry so own()/reset()/'reset' are real. */
function makeCtx(): { ctx: WorkbenchContext; simulatorWc: MockWc; connections: ReturnType<typeof createConnectionRegistry> } {
  const simulatorWc = stubs.makeWebContents()
  const connections = createConnectionRegistry()
  const ctx = {
    registry: { add: (_fn: AnyFn) => {} },
    simulatorApis: { has: (_name: string) => false, invoke: async () => ({}) },
    windows: { mainWindow: { webContents: simulatorWc } },
    workspace: { getSession: () => undefined },
    connections,
  } as unknown as WorkbenchContext
  return { ctx, simulatorWc, connections }
}

/**
 * Spawn an app session and return the live service-host webContents + the
 * spawn result. `handleSpawn` is async (it awaits app-config.json over fetch,
 * which fails offline and is swallowed); run it under fake timers and let the
 * microtask queue flush.
 */
async function spawnSession(simulatorWc: MockWc): Promise<{ result: SpawnResult; serviceWc: MockWc }> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  const req: SpawnRequest = {
    appId: 'demo-app',
    pagePath: 'pages/index/index',
    // Supply a resourceBaseUrl so handleSpawn skips startDiminaResourceServer.
    resourceBaseUrl: 'http://127.0.0.1:1/',
  }
  const result = (await (handle as AnyFn)({ sender: simulatorWc }, req)) as SpawnResult
  const serviceWc = stubs.wcById.get(result.serviceWcId)
  if (!serviceWc) throw new Error(`no mock webContents with id ${result.serviceWcId}`)
  return { result, serviceWc: serviceWc as unknown as MockWc }
}

/** Trigger the (non-serviceAlreadyClosed) dispose for an app session via the
 *  DISPOSE IPC, sent from the service-host wc so the sender check passes. This
 *  is the pool-reuse path: poolEntryId !== null && pool && !serviceAlreadyClosed. */
function disposeViaIpc(serviceWc: MockWc, bridgeId: string): void {
  const payload: DisposePayload = { bridgeId }
  emitOn(C.DISPOSE, serviceWc, payload)
}

describe('bridge-router — service-host connection tracking + pool-reuse reset', () => {
  it('(1) tracks a LIVE connection for the service-host webContents after spawn', async () => {
    const { ctx, simulatorWc, connections } = makeCtx()
    installBridgeRouter(ctx)
    const { serviceWc } = await spawnSession(simulatorWc)

    // Implemented: spawn acquires a connection for serviceWc (in addition to the
    // render guest), so this is a live connection after spawn.
    const conn = connections.get(serviceWc.id)
    expect(conn, 'spawn must acquire a connection for the service-host webContents').toBeDefined()
    expect(conn!.alive, 'the service-host connection must be alive after spawn').toBe(true)
  })

  it('(2)+(3) RESETs (not closes) the service-host connection on pool-reuse, disposing the old segment and clearing wc bookkeeping', async () => {
    const { ctx, simulatorWc, connections } = makeCtx()
    installBridgeRouter(ctx)
    const { result, serviceWc } = await spawnSession(simulatorWc)

    const conn = connections.get(serviceWc.id)
    // Guard: assertion (1) must hold for the rest of this test to be meaningful.
    expect(conn, 'service-host connection must exist after spawn').toBeDefined()

    // Own a per-session resource on the service-host connection's CURRENT
    // lifetime segment, and subscribe to 'reset'. On pool-reuse the router must
    // reset() the connection: the segment is disposed (ownDisposed → true) and
    // 'reset' fires, while the connection STAYS ALIVE (it is reused, not closed).
    let ownDisposed = false
    let resetFired = false
    conn!.own(() => { ownDisposed = true })
    conn!.on('reset', () => { resetFired = true })

    // Dispose on the pool-reuse path (window returned to the pool, not closed).
    disposeViaIpc(serviceWc, result.bridgeId)
    // disposeAppSession is async (awaits pool.release); flush microtasks.
    await Promise.resolve()
    await Promise.resolve()

    // Pool-reuse signal: the window was RELEASED to the pool, not destroyed.
    expect(stubs.releaseCalls.length, 'pool.release must run (pool-reuse path)').toBe(1)
    expect(serviceWc.destroyed, 'pool-reuse must NOT destroy the service window').toBe(false)

    // (2) The connection is RESET, not closed: still alive, old segment disposed,
    // 'reset' fired.
    const after = connections.get(serviceWc.id)
    expect(after, 'reset keeps the connection registered/alive (reuse)').toBeDefined()
    expect(after!.alive, 'reset must keep the connection alive').toBe(true)
    expect(resetFired, "a 'reset' event must fire on pool-reuse").toBe(true)
    expect(ownDisposed, 'the previous segment resource must be disposed by reset').toBe(true)

    // (3) The per-serviceWc bookkeeping must be cleared so the next session
    // reusing this wc starts clean. We probe it indirectly: a DISPOSE issued
    // again from this serviceWc must find NO app session bound to it (the
    // serviceWc → appSessionId binding is gone), so no second pool.release runs.
    disposeViaIpc(serviceWc, result.bridgeId)
    await Promise.resolve()
    expect(
      stubs.releaseCalls.length,
      'serviceWc → appSession binding must be cleared by reset (no stale session)',
    ).toBe(1)
  })
})
