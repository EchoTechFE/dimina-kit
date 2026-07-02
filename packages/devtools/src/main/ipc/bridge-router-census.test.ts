/**
 * The bridge router owns RouterState — every session/binding/pending-call
 * ledger — so it also owns the resource census: a point-in-time count of each
 * resource class, exposed to e2e as the test-gated
 * `globalThis.__diminaResourceCensus`. Coarse memory sampling cannot see a
 * leaked listener or a stale map entry (KB-scale noise inside an MB-scale
 * process), so leak coverage asserts EXACT ledger equality around a churn
 * cycle instead. These tests pin the ledger's shape and its return-to-baseline
 * contract across spawn → dispose.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  const onListeners = new Map<string, Set<AnyFn>>()
  const invokeHandlers = new Map<string, AnyFn>()

  function makeEmitter() {
    const listeners: EventBag = {}
    // Node's removeListener(fn) also removes the internal once() wrapper for
    // fn (it keeps a `.listener` back-reference); mirror that so production
    // code detaching its own once() hooks behaves the same against this mock.
    const removeMatching = (event: string, fn: AnyFn): void => {
      const set = listeners[event]
      if (!set) return
      for (const l of [...set]) {
        if (l === fn || (l as AnyFn & { listener?: AnyFn }).listener === fn) set.delete(l)
      }
    }
    const api = {
      listeners,
      on(event: string, fn: AnyFn) { (listeners[event] ??= new Set()).add(fn); return api },
      once(event: string, fn: AnyFn) {
        const wrap: AnyFn & { listener?: AnyFn } = (...a: unknown[]) => { listeners[event]?.delete(wrap); return fn(...a) }
        wrap.listener = fn
        ;(listeners[event] ??= new Set()).add(wrap); return api
      },
      off(event: string, fn: AnyFn) { removeMatching(event, fn); return api },
      removeListener(event: string, fn: AnyFn) { removeMatching(event, fn); return api },
      listenerCount(event: string) { return listeners[event]?.size ?? 0 },
      emit(event: string, ...a: unknown[]) { for (const fn of [...(listeners[event] ?? [])]) fn(...a) },
    }
    return api
  }

  let nextWcId = 7000
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

  function createWindowForSpawn(opts?: Record<string, unknown>) {
    const win = makeBrowserWindow()
    createdWindows.push(win)
    void opts
    return win
  }

  function reset() {
    onListeners.clear()
    invokeHandlers.clear()
    wcById.clear()
    createdWindows.length = 0
    nextWcId = 7000
  }

  return {
    onListeners, invokeHandlers, wcById,
    makeEmitter, makeWebContents, makeBrowserWindow, createWindowForSpawn,
    createdWindows,
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

// Pooling OFF: every spawn takes the fresh-window path so the census counts
// reflect only the router's own bookkeeping.
vi.mock('../windows/service-host-window/create.js', () => ({
  serviceHostSpec: () => ({}),
  serviceHostPreloadPath: '/tmp/preload.cjs',
  SERVICE_HOST_PARTITION: 'persist:simulator',
  buildServiceHostSpawnUrl: () => 'file:///service.html',
  navigateServiceHost: vi.fn(() => Promise.resolve()),
  createServiceHostWindow: vi.fn((opts: Record<string, unknown>) => stubs.createWindowForSpawn(opts)),
  constructServiceHostWindow: vi.fn(() => stubs.createWindowForSpawn()),
}))

import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type { DisposePayload, MessageEnvelope, ServiceInvokePayload, SpawnRequest, SpawnResult } from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { BridgeResourceCensus } from './bridge-router.js'

type AnyFn = (...args: unknown[]) => unknown
type MockWc = ReturnType<typeof stubs.makeWebContents>

const APP_ID = 'census-app'
const ROOT_A = 'pages/root-a/root-a'
const ROOT_B = 'pages/root-b/root-b'

let installBridgeRouter: typeof import('./bridge-router.js').installBridgeRouter

let originalFetch: typeof globalThis.fetch

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  originalFetch = globalThis.fetch
  globalThis.fetch = vi.fn((input: string | URL | Request) => {
    const href = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : (input as Request).url
    if (href.includes('app-config.json')) {
      const body = { app: { entryPagePath: ROOT_A, pages: [ROOT_A, ROOT_B] } }
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response)
    }
    return Promise.resolve({ ok: true, status: 200, text: async () => '', json: async () => ({}) } as unknown as Response)
  }) as unknown as typeof fetch
  ;({ installBridgeRouter } = await import('./bridge-router.js'))
})

afterEach(() => {
  globalThis.fetch = originalFetch
  delete (globalThis as Record<string, unknown>).__diminaResourceCensus
})

function makeCtx(): { ctx: WorkbenchContext; simulatorWc: MockWc } {
  const simulatorWc = stubs.makeWebContents()
  const ctx = {
    registry: { add: (_fn: AnyFn) => {} },
    simulatorApis: { has: (_name: string) => false, invoke: async () => ({}) },
    windows: { mainWindow: { webContents: simulatorWc } },
    workspace: { getSession: () => undefined },
    connections: createConnectionRegistry(),
  } as unknown as WorkbenchContext
  return { ctx, simulatorWc }
}

async function spawnSession(simulatorWc: MockWc, pagePath: string): Promise<SpawnResult> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  const req: SpawnRequest = { appId: APP_ID, pagePath, resourceBaseUrl: 'http://127.0.0.1:1/' }
  return (await (handle as AnyFn)({ sender: simulatorWc }, req)) as SpawnResult
}

function emitOn(channel: string, sender: unknown, payload: unknown): void {
  const fns = stubs.onListeners.get(channel)
  if (!fns) throw new Error(`no ipcMain.on listener for ${channel}`)
  for (const fn of [...fns]) fn({ sender }, payload)
}

/** Forward an `audioListen` invokeAPI so a pending API call exists. */
function forwardAudioListen(serviceWcId: number, bridgeId: string): void {
  const serviceWc = stubs.wcById.get(serviceWcId)
  if (!serviceWc) throw new Error(`no service wc ${serviceWcId}`)
  const msg: MessageEnvelope = {
    type: 'invokeAPI',
    target: 'container',
    body: { name: 'audioListen', params: { audioId: 7, success: 11 } },
  }
  const payload: ServiceInvokePayload = { bridgeId, msg }
  emitOn(C.SERVICE_INVOKE, serviceWc, payload)
}

function readCensus(): BridgeResourceCensus {
  const probe = (globalThis as Record<string, unknown>).__diminaResourceCensus
  if (typeof probe !== 'function') throw new Error('__diminaResourceCensus not registered')
  return (probe as () => BridgeResourceCensus)()
}

async function flushDispose(): Promise<void> {
  // disposeAppSession clears the ledger in its synchronous prefix; a couple of
  // microtask turns absorb the async tail (resource-server close settle).
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

describe('bridge-router resource census', () => {
  it('registers the test-gated global census probe on install', () => {
    const { ctx } = makeCtx()
    installBridgeRouter(ctx)
    expect(typeof (globalThis as Record<string, unknown>).__diminaResourceCensus).toBe('function')
  })

  it('counts sessions, wc bindings, destroyed-hooks and pending API calls while sessions are live', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const a = await spawnSession(simulatorWc, ROOT_A)
    const b = await spawnSession(simulatorWc, ROOT_B)

    const census = readCensus()
    expect(census.appSessions).toBe(2)
    expect(census.pageSessions).toBe(2)
    expect(census.serviceWcBindings).toBe(2)
    expect(census.simulatorWcs).toBe(1)
    expect(census.simulatorWcBindings).toBe(2)
    // One 'destroyed' teardown hook per live session on the SHARED wc — the
    // exact counter that catches the one-dead-listener-per-soft-reload class.
    expect(census.simulatorDestroyedListeners).toEqual({ [simulatorWc.id]: 2 })
    expect(census.pendingApiCalls).toBe(0)

    forwardAudioListen(a.serviceWcId, a.bridgeId)
    expect(readCensus().pendingApiCalls).toBe(1)
    void b
  })

  it('returns the ledger exactly to baseline after every session disposes', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const baseline = readCensus()

    const a = await spawnSession(simulatorWc, ROOT_A)
    const b = await spawnSession(simulatorWc, ROOT_B)
    forwardAudioListen(a.serviceWcId, a.bridgeId)
    expect(readCensus().appSessions).toBe(2)

    emitOn(C.DISPOSE, simulatorWc, { bridgeId: a.bridgeId, appSessionId: a.appSessionId } as DisposePayload)
    await flushDispose()
    const mid = readCensus()
    expect(mid.appSessions).toBe(1)
    expect(mid.simulatorWcBindings).toBe(1)
    expect(mid.simulatorDestroyedListeners).toEqual({ [simulatorWc.id]: 1 })
    // A's pending audioListen died with A.
    expect(mid.pendingApiCalls).toBe(0)

    emitOn(C.DISPOSE, simulatorWc, { bridgeId: b.bridgeId, appSessionId: b.appSessionId } as DisposePayload)
    await flushDispose()
    expect(readCensus()).toEqual(baseline)
  })
})
