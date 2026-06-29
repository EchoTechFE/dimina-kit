/**
 * Contract: disposeSessionsForSimulator(simWcId) returns a Promise that
 * resolves only after the asynchronous resource-cleanup inside disposeAppSession
 * (pool.release / resourceServer.close) has completed.
 *
 * The current BridgeRouterHandle signature is `void`; after the refactor it
 * must be `Promise<void>`. Callers that need to wait for full cleanup (e.g.
 * the workspace-service detachSimulator path) will await the returned promise
 * so they don't proceed while the outgoing session's resources are still live.
 *
 * Test seam: spawn a session whose resource server has a deferred close()
 * (controlled by the test), then assert that the returned value is a Promise
 * that does not settle until the deferred close resolves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoisted stubs shared with the dispose-path test ─────────────────────────
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

// Deferred resource-server factory: each test injects its own resolver.
let currentServerCloseImpl: (() => Promise<void>) | null = null

vi.mock('../services/dimina-resource-server.js', () => ({
  startDiminaResourceServer: vi.fn(async () => ({
    baseUrl: 'http://127.0.0.1:19888/',
    close: vi.fn(() => currentServerCloseImpl?.() ?? Promise.resolve()),
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
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

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
  currentServerCloseImpl = null
  ;({ installBridgeRouter } = await import('./bridge-router.js'))
})

afterEach(() => {
  if (PRIOR_POOL_ENV === undefined) delete process.env.DIMINA_PREWARM_POOL_SIZE
  else process.env.DIMINA_PREWARM_POOL_SIZE = PRIOR_POOL_ENV
  if (PRIOR_DISABLE_ENV === undefined) delete process.env.DIMINA_PREWARM_DISABLE
  else process.env.DIMINA_PREWARM_DISABLE = PRIOR_DISABLE_ENV
})

function makeCtx(): { ctx: WorkbenchContext; simulatorWc: MockWc } {
  const simulatorWc = stubs.makeWebContents()
  const ctx = {
    registry: { add: (_fn: AnyFn) => {} },
    simulatorApis: { has: (_name: string) => false, invoke: async () => ({}) },
    windows: { mainWindow: { webContents: simulatorWc } },
    workspace: { getSession: () => undefined },
    connections: createConnectionRegistry(),
    appData: undefined,
  } as unknown as WorkbenchContext
  return { ctx, simulatorWc }
}

async function spawnWithResourceServer(simulatorWc: MockWc): Promise<SpawnResult> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  // Omit resourceBaseUrl so the router calls startDiminaResourceServer and
  // ap.resourceServer is set — the only way to exercise the async close path.
  const req: SpawnRequest = {
    appId: 'dispose-test-app',
    pagePath: 'pages/index/index',
    // No resourceBaseUrl: falls through to startDiminaResourceServer
  }
  return (await (handle as AnyFn)({ sender: simulatorWc }, req)) as SpawnResult
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('bridge-router — disposeSessionsForSimulator returns an awaitable Promise', () => {
  /**
   * disposeSessionsForSimulator must return Promise<void> (not void/undefined)
   * so callers can await the full async cleanup of the outgoing session's
   * resources (pool.release / resourceServer.close) before proceeding with
   * the next project's setup. The current signature is void, which drops the
   * async tail via `void disposeAppSession(...)` — the returned value is
   * undefined, not a Promise.
   *
   * Failure predicate: with the current `void` return, the assertion
   * `expect(result).toBeInstanceOf(Promise)` fails immediately.
   */
  it('returns a Promise (not void/undefined)', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    // Any session is sufficient to make the call meaningful.
    await spawnWithResourceServer(simulatorWc)
    await flush()

    const result = ctx.bridge!.disposeSessionsForSimulator!(simulatorWc.id)

    expect(
      result,
      'disposeSessionsForSimulator must return a Promise so callers can await '
      + 'the async resource cleanup — returning void/undefined drops the tail',
    ).toBeInstanceOf(Promise)
  })

  /**
   * The returned Promise must not settle before resourceServer.close()
   * resolves. Without this guarantee, a caller that awaits
   * disposeSessionsForSimulator and then opens the next project may spawn into
   * a port that the previous resource server still holds.
   *
   * Failure predicate: if the impl returns `void` (fails the previous test)
   * or resolves before close finishes, this test also fails — either the
   * returned value isn't a Promise or it settles too early.
   */
  it('the returned Promise does not settle before resourceServer.close() resolves', async () => {
    let resolveClose!: () => void
    currentServerCloseImpl = () => new Promise<void>((resolve) => { resolveClose = resolve })

    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    await spawnWithResourceServer(simulatorWc)
    await flush()

    const result = ctx.bridge!.disposeSessionsForSimulator!(simulatorWc.id)

    // Only proceed if the previous contract (returns Promise) is met.
    expect(result).toBeInstanceOf(Promise)
    if (!(result instanceof Promise)) return

    let settled = false
    void result.then(() => { settled = true })

    // Drain microtasks — close is still pending so the Promise must not settle.
    await flush()
    expect(
      settled,
      'disposeSessionsForSimulator must remain pending while resourceServer.close() is pending',
    ).toBe(false)

    // Unblock the resource server and await the result.
    resolveClose()
    await result

    expect(
      settled,
      'disposeSessionsForSimulator must resolve after resourceServer.close() resolves',
    ).toBe(true)
  })
})
