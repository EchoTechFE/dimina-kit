/**
 * Contract: `ctx.registry` (a `DisposableRegistry`) must not grow one stale
 * entry per app-session respawn. `installBridgeRouter` registers a
 * shutdown-fallback entry per spawned session
 * (`ctx.registry.add(() => disposeAppSession(...))`) so that a session still
 * live at whole-app shutdown is still torn down. When that session is instead
 * disposed earlier — via `ctx.bridge.disposeSessionsForSimulator(simulatorWcId)`
 * — its registry entry must be released too, otherwise `ctx.registry`'s
 * internal array grows without bound across the lifetime of the process.
 *
 * Real bug it guards: the spawn code used to discard the `Disposable` handle
 * returned by `ctx.registry.add(...)`. A `DisposableRegistry` entry is only
 * removed when THAT handle's `.dispose()` is called — dropping the handle
 * means every respawn permanently appends a closure that retains `state` and a
 * dead session id, with `ctx.registry.size` climbing 1, 2, 3, … forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoisted stubs — copied verbatim from bridge-router-dispose-awaitable.test.ts ──
const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  const onListeners = new Map<string, Set<AnyFn>>()
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

  let nextWcId = 5000
  const wcById = new Map<number, ReturnType<typeof makeWebContents>>()
  function makeWebContents() {
    const em = makeEmitter()
    const wc = {
      ...em,
      id: nextWcId++,
      destroyed: false,
      isDestroyed() { return this.destroyed },
      getURL: () => 'file:///service.html',
      getType: () => 'window',
      send: vi.fn(),
      executeJavaScript: vi.fn(() => Promise.resolve(undefined)),
      openDevTools: vi.fn(),
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
      close: vi.fn(),
      loadURL: vi.fn(() => Promise.resolve()),
      loadFile: vi.fn(() => Promise.resolve()),
    }
    return win
  }

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
    nextWcId = 5000
  }

  return { onListeners, invokeHandlers, wcById, createdWindows, makeEmitter, makeWebContents, makeBrowserWindow, createWindowForSpawn, reset }
})

vi.mock('../services/dimina-resource-server.js', () => ({
  startDiminaResourceServer: vi.fn(async () => ({
    baseUrl: 'http://127.0.0.1:19888/',
    close: vi.fn(() => Promise.resolve()),
  })),
}))

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
import type { SpawnRequest, SpawnResult } from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import { createConnectionRegistry, DisposableRegistry } from '@dimina-kit/electron-deck/main'

type AnyFn = (...args: unknown[]) => unknown
type MockWc = ReturnType<typeof stubs.makeWebContents>

const PRIOR_POOL_ENV = process.env.DIMINA_PREWARM_POOL_SIZE
const PRIOR_DISABLE_ENV = process.env.DIMINA_PREWARM_DISABLE

let installBridgeRouter: typeof import('./bridge-router.js').installBridgeRouter

beforeEach(async () => {
  delete process.env.DIMINA_PREWARM_POOL_SIZE
  delete process.env.DIMINA_PREWARM_DISABLE
  vi.resetModules()
  stubs.reset()
  ;({ installBridgeRouter } = await import('./bridge-router.js'))
})

afterEach(() => {
  if (PRIOR_POOL_ENV === undefined) delete process.env.DIMINA_PREWARM_POOL_SIZE
  else process.env.DIMINA_PREWARM_POOL_SIZE = PRIOR_POOL_ENV
  if (PRIOR_DISABLE_ENV === undefined) delete process.env.DIMINA_PREWARM_DISABLE
  else process.env.DIMINA_PREWARM_DISABLE = PRIOR_DISABLE_ENV
})

// Only `registry` differs from the dispose-awaitable sibling: a REAL
// DisposableRegistry (not a `{ add: () => {} }` stub) so the test can observe
// `.size` — the live entry count — across spawn/dispose cycles.
function makeCtx(): { ctx: WorkbenchContext; registry: DisposableRegistry; simulatorWc: MockWc } {
  const simulatorWc = stubs.makeWebContents()
  const registry = new DisposableRegistry()
  const ctx = {
    registry,
    simulatorApis: { has: (_name: string) => false, invoke: async () => ({}) },
    windows: { mainWindow: { webContents: simulatorWc } },
    workspace: { getSession: () => undefined },
    connections: createConnectionRegistry(),
    appData: undefined,
  } as unknown as WorkbenchContext
  return { ctx, registry, simulatorWc }
}

async function spawnWithResourceServer(simWc: MockWc, appId: string): Promise<SpawnResult> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  // Omit resourceBaseUrl so the router calls startDiminaResourceServer, matching
  // the real spawn path that owns a registry shutdown-fallback entry.
  const req: SpawnRequest = {
    appId,
    pagePath: 'pages/index/index',
  }
  return (await (handle as AnyFn)({ sender: simWc }, req)) as SpawnResult
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('bridge-router — ctx.registry does not leak one entry per respawn', () => {
  /**
   * Repeated spawn→dispose cycles (each on a fresh simulator webContents, i.e. a
   * fresh session) must leave `ctx.registry.size` bounded. The leaky
   * implementation (discarding `ctx.registry.add(...)`'s returned handle) makes
   * size climb 1, 2, 3, 4, 5 across 5 cycles because disposal never releases the
   * shutdown-fallback entry the spawn installed. The fixed implementation
   * releases that entry as part of disposeAppSession, so size returns to (and
   * stays at) whatever baseline the first cycle leaves behind.
   */
  it('registry.size does not grow across repeated spawn+dispose cycles', async () => {
    const { ctx, registry } = makeCtx()
    installBridgeRouter(ctx)

    const N = 5
    const sizesAfterEachCycle: number[] = []

    for (let i = 0; i < N; i++) {
      const simWc = stubs.makeWebContents()
      await spawnWithResourceServer(simWc, `respawn-leak-app-${i}`)
      await flush()

      await ctx.bridge!.disposeSessionsForSimulator!(simWc.id)
      await flush()

      sizesAfterEachCycle.push(registry.size)
    }

    const baseline = sizesAfterEachCycle[0]!
    const finalSize = sizesAfterEachCycle[N - 1]!

    expect(
      finalSize,
      `ctx.registry.size grew from ${baseline} to ${finalSize} across ${N} spawn+dispose `
      + `cycles (sizes per cycle: [${sizesAfterEachCycle.join(', ')}]) — each disposed `
      + 'session must release its own shutdown-fallback registry entry instead of '
      + 'leaving a stale closure behind forever.',
    ).toBeLessThanOrEqual(baseline)

    // Every cycle disposes exactly the session it spawned, so the registry must
    // settle at a flat baseline, not merely "not much larger than N".
    expect(sizesAfterEachCycle.every((size) => size === baseline)).toBe(true)
  })
})
