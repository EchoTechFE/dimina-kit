/**
 * Guards that handleSpawn forwards ctx.apiNamespaces to createServiceHostWindow
 * so the service-host URL can encode the namespaces as a query param and the
 * preload installs the correct global namespace objects before service.js runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

// ── Hoisted stubs ────────────────────────────────────────────────────────────

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
      emit(event: string, ...a: unknown[]) {
        for (const fn of [...(listeners[event] ?? [])]) fn(...a)
      },
    }
    return api
  }

  let nextWcId = 5000

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
  const createWindowCallOpts: Array<Record<string, unknown>> = []
  // Opts captured from each buildServiceHostSpawnUrl call. The pooled spawn
  // branch builds the spawn URL itself (the fresh-window branch goes through
  // createServiceHostWindow instead), so this is how the pooled path's
  // apiNamespaces forwarding is observed.
  const spawnUrlOpts: Array<Record<string, unknown>> = []

  function createWindowForSpawn(opts?: Record<string, unknown>) {
    const win = makeBrowserWindow()
    createdWindows.push(win)
    if (opts !== undefined) createWindowCallOpts.push(opts)
    return win
  }

  // A warmed window handed back by the mocked pool's `acquire` on the pooled
  // spawn branch. Shaped like a real BrowserWindow so handleSpawn can navigate
  // it and bind its webContents.
  function acquirePooledWindow() {
    const win = makeBrowserWindow()
    createdWindows.push(win)
    return win
  }

  function reset() {
    onListeners.clear()
    invokeHandlers.clear()
    createdWindows.length = 0
    createWindowCallOpts.length = 0
    spawnUrlOpts.length = 0
    nextWcId = 5000
  }

  return {
    onListeners, invokeHandlers,
    makeEmitter, makeWebContents, makeBrowserWindow, createWindowForSpawn,
    acquirePooledWindow,
    createdWindows, createWindowCallOpts, spawnUrlOpts,
    reset,
  }
})

// ── Module mocks ─────────────────────────────────────────────────────────────

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
    app: { isPackaged: true, getLocale: () => 'en-US', getPath: vi.fn(() => '/tmp/dimina-test') },
    BrowserWindow: class {},
    WebContentsView: class { webContents = {}; setBounds = vi.fn(); setBackgroundColor = vi.fn() },
    protocol: protocolStub,
    session: sessionStub,
    webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
    nativeTheme: { themeSource: 'system', on: vi.fn() },
    default: {},
  }
})

// The fresh-window path goes through createServiceHostWindow; the pooled path
// builds the spawn URL via buildServiceHostSpawnUrl. The latter is a capturing
// vi.fn so the pooled branch's opts (including apiNamespaces) are observable.
vi.mock('../windows/service-host-window/create.js', () => ({
  serviceHostSpec: () => ({}),
  serviceHostPreloadPath: '/tmp/preload.cjs',
  SERVICE_HOST_PARTITION: 'persist:simulator',
  buildServiceHostSpawnUrl: vi.fn((opts: Record<string, unknown>) => {
    stubs.spawnUrlOpts.push(opts)
    return 'file:///service.html'
  }),
  navigateServiceHost: vi.fn(() => Promise.resolve()),
  createServiceHostWindow: vi.fn((opts: Record<string, unknown>) => stubs.createWindowForSpawn(opts)),
  constructServiceHostWindow: vi.fn(() => stubs.createWindowForSpawn()),
}))

// Mocked pre-warm pool: `acquire` hands back a warmed window stub so the pooled
// spawn branch (state.pool !== null) runs without a real BrowserWindow. `init`/
// `dispose` are inert — the warm-up timer is never advanced in these tests.
vi.mock('../services/service-host-pool/pool.js', () => ({
  ServiceHostPool: class {
    init = vi.fn(() => Promise.resolve())
    dispose = vi.fn(() => Promise.resolve())
    acquire = vi.fn(() => Promise.resolve({ win: stubs.acquirePooledWindow(), entryId: 'entry-1' }))
  },
}))

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type { SpawnRequest } from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'

type AnyFn = (...args: unknown[]) => unknown
type MockWc = ReturnType<typeof stubs.makeWebContents>

const APP_ID = 'test-app'

let installBridgeRouter: typeof import('./bridge-router.js').installBridgeRouter

const PRIOR_POOL_ENV = process.env.DIMINA_PREWARM_POOL_SIZE
const PRIOR_DISABLE_ENV = process.env.DIMINA_PREWARM_DISABLE
let originalFetch: typeof globalThis.fetch

// ── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(async () => {
  // Pool OFF: every spawn uses the fresh-window path.
  delete process.env.DIMINA_PREWARM_POOL_SIZE
  delete process.env.DIMINA_PREWARM_DISABLE
  vi.resetModules()
  stubs.reset()
  originalFetch = globalThis.fetch
  // Return a valid empty app-config for all fetches so handleSpawn completes.
  globalThis.fetch = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '{}',
    } as unknown as Response),
  ) as unknown as typeof fetch
  ;({ installBridgeRouter } = await import('./bridge-router.js'))
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (PRIOR_POOL_ENV === undefined) delete process.env.DIMINA_PREWARM_POOL_SIZE
  else process.env.DIMINA_PREWARM_POOL_SIZE = PRIOR_POOL_ENV
  if (PRIOR_DISABLE_ENV === undefined) delete process.env.DIMINA_PREWARM_DISABLE
  else process.env.DIMINA_PREWARM_DISABLE = PRIOR_DISABLE_ENV
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(apiNamespaces: string[] = []): { ctx: WorkbenchContext; simulatorWc: MockWc } {
  const simulatorWc = stubs.makeWebContents()
  const ctx = {
    registry: { add: (_fn: AnyFn) => {} },
    simulatorApis: { has: (_name: string) => false, invoke: async () => ({}) },
    windows: { mainWindow: { webContents: simulatorWc } },
    workspace: { getSession: () => undefined },
    connections: createConnectionRegistry(),
    apiNamespaces,
  } as unknown as WorkbenchContext
  return { ctx, simulatorWc }
}

async function spawnSession(simulatorWc: MockWc): Promise<void> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  const req: SpawnRequest = {
    appId: APP_ID,
    pagePath: 'pages/index/index',
    resourceBaseUrl: 'http://127.0.0.1:1/',
  }
  await (handle as AnyFn)({ sender: simulatorWc }, req)
}

async function flush(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('bridge-router — ctx.apiNamespaces forwarded to service host window', () => {
  it('passes ctx.apiNamespaces to createServiceHostWindow opts so the spawn URL can encode the namespace globals', async () => {
    const { ctx, simulatorWc } = makeCtx(['qd'])
    installBridgeRouter(ctx)
    await spawnSession(simulatorWc)
    await flush()

    expect(stubs.createWindowCallOpts).toHaveLength(1)
    expect(stubs.createWindowCallOpts[0]).toMatchObject({ apiNamespaces: ['qd'] })
  })

  it('passes an empty apiNamespaces array to createServiceHostWindow when ctx.apiNamespaces is empty', async () => {
    const { ctx, simulatorWc } = makeCtx([])
    installBridgeRouter(ctx)
    await spawnSession(simulatorWc)
    await flush()

    expect(stubs.createWindowCallOpts).toHaveLength(1)
    const val = stubs.createWindowCallOpts[0]?.apiNamespaces
    expect(Array.isArray(val) ? val : undefined).toEqual([])
  })
})

describe('bridge-router — ctx.apiNamespaces forwarded on the pooled spawn path', () => {
  it('threads ctx.apiNamespaces into buildServiceHostSpawnUrl when a warmed pool window serves the spawn', async () => {
    // Enable the pre-warm pool BEFORE installBridgeRouter reads the env, so
    // state.pool is non-null and the spawn takes the pooled (acquire) branch
    // instead of constructing a fresh window. (The fresh-path tests above delete
    // this env to force the other branch; this is the inverse.)
    process.env.DIMINA_PREWARM_POOL_SIZE = '1'

    const { ctx, simulatorWc } = makeCtx(['qd'])
    installBridgeRouter(ctx)
    await spawnSession(simulatorWc)
    await flush()

    // The pooled branch builds the spawn URL itself; the fresh-window helper is
    // never called on this path.
    expect(stubs.createWindowCallOpts).toHaveLength(0)
    expect(stubs.spawnUrlOpts).toHaveLength(1)
    expect(stubs.spawnUrlOpts[0]).toMatchObject({ apiNamespaces: ['qd'] })
  })
})
