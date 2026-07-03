/**
 * A single simulator webContents can host MULTIPLE app sessions at once
 * (soft reload spawns session B into the SAME simulator wc before the OLD
 * session A is disposed — see bridge-router-multi-session-overlap.test.ts).
 * `DISPOSE` / `ACTIVE_PAGE` / `PAGE_LIFECYCLE` already resolve their target
 * session by the id the message names, so both A and B stay independently
 * reachable through the shared wc regardless of spawn order.
 *
 * `API_RESPONSE`, however, carries only a `requestId` — no session id. Each
 * pending call is OWNED by the session that issued it (`pending.appSessionId`,
 * set when the service host forwards the API via SERVICE_INVOKE); routing an
 * API_RESPONSE always resolves the pending by that ownership, never by which
 * session is newest. Authorization is a separate question: the SENDER wc
 * must be BOUND to the pending's owning session — a simulator wc is bound to
 * every session it hosts, so the shared wc authorizes an API_RESPONSE for
 * EITHER A's or B's requestId while both are alive. A DIFFERENT simulator wc
 * that never hosted the owning session is rejected (anti-spoofing), even for
 * the correct requestId.
 *
 * Once a session is disposed it is no longer bound to any wc, so an
 * API_RESPONSE for its former pending calls can no longer be authorized
 * through that wc; the remaining live session(s) stay resolvable regardless
 * of dispose order.
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
      emit(event: string, ...a: unknown[]) { for (const fn of [...(listeners[event] ?? [])]) fn(...a) },
    }
    return api
  }

  let nextWcId = 9000
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
    nextWcId = 9000
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

// Pooling OFF: every spawn takes the fresh-window path, so the shared-wc
// binding under test is purely the router's own bookkeeping, not a pooled
// service window's identity.
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
import type { ApiResponsePayload, DisposePayload, MessageEnvelope, PageLifecyclePayload, ServiceInvokePayload, SpawnRequest, SpawnResult } from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'

type AnyFn = (...args: unknown[]) => unknown
type MockWc = ReturnType<typeof stubs.makeWebContents>
type MockWin = ReturnType<typeof stubs.makeBrowserWindow>

const APP_ID = 'multi-session-app'
const ROOT_A = 'pages/root-a/root-a'
const ROOT_B = 'pages/root-b/root-b'
const ROOT_C = 'pages/root-c/root-c'

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
      const body = { app: { entryPagePath: ROOT_A, pages: [ROOT_A, ROOT_B, ROOT_C] } }
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

async function spawnSession(
  simulatorWc: MockWc,
  opts: { pagePath: string },
): Promise<{ result: SpawnResult; serviceWc: MockWc; serviceWindow: MockWin }> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  const req: SpawnRequest = {
    appId: APP_ID,
    pagePath: opts.pagePath,
    resourceBaseUrl: 'http://127.0.0.1:1/',
  }
  const result = (await (handle as AnyFn)({ sender: simulatorWc }, req)) as SpawnResult
  const serviceWc = stubs.wcById.get(result.serviceWcId) as MockWc | undefined
  if (!serviceWc) throw new Error(`no mock webContents with id ${result.serviceWcId}`)
  const serviceWindow = stubs.createdWindows.find(w => w.webContents.id === result.serviceWcId)
  if (!serviceWindow) throw new Error('spawned service window not found')
  return { result, serviceWc, serviceWindow }
}

/** Fire an `ipcMain.on` channel as if a renderer/webview sent it. */
function emitOn(channel: string, sender: unknown, payload: unknown): void {
  const fns = stubs.onListeners.get(channel)
  if (!fns) throw new Error(`no ipcMain.on listener for ${channel}`)
  for (const fn of [...fns]) fn({ sender }, payload)
}

function emitDispose(simulatorWc: MockWc, payload: DisposePayload): void {
  emitOn(C.DISPOSE, simulatorWc, payload)
}

function emitPageLifecycle(simulatorWc: MockWc, payload: PageLifecyclePayload): void {
  emitOn(C.PAGE_LIFECYCLE, simulatorWc, payload)
}

/** Forward an `audioListen` invokeAPI from the service through the router. */
function forwardAudioListen(serviceWc: MockWc, bridgeId: string, callbacks: {
  success?: unknown; complete?: unknown; fail?: unknown
}): void {
  const msg: MessageEnvelope = {
    type: 'invokeAPI',
    target: 'container',
    body: {
      name: 'audioListen',
      // Native-host reality: `keep` already stripped by the submodule. Only the
      // service-side callback ids + the audioId survive.
      params: { audioId: 7, ...callbacks },
    },
  }
  const payload: ServiceInvokePayload = { bridgeId, msg }
  emitOn(C.SERVICE_INVOKE, serviceWc, payload)
}

/** The `requestId` of the most recently forwarded `simulator:api-call`. */
function latestApiCallRequestId(simulatorWc: MockWc): string {
  const calls = simulatorWc.sentMessages.filter(m => m.channel === 'simulator:api-call')
  const last = calls.at(-1)
  if (!last) throw new Error('no api-call sent to the simulator wc')
  return (last.payload as { requestId: string }).requestId
}

/** Emit an `API_RESPONSE` as if the DEVICE (simulator wc) acked an API_CALL. */
function apiResponseFrom(simulatorWc: MockWc, requestId: string, appSessionId: string, result: unknown): void {
  const payload = { appSessionId, requestId, ok: true, result } as ApiResponsePayload
  emitOn(C.API_RESPONSE, simulatorWc, payload)
}

/** triggerCallback messages the router sent to a service webContents. */
function triggerCallbacks(serviceWc: MockWc): Array<{ id: unknown; args: unknown }> {
  return serviceWc.sentMessages
    .filter(m => m.channel === C.TO_SERVICE)
    .map(m => (m.payload as { msg?: MessageEnvelope }).msg)
    .filter((m): m is MessageEnvelope => !!m && m.type === 'triggerCallback')
    .map(m => m.body as { id: unknown; args: unknown })
}

/**
 * Drop everything a webContents mock has recorded so the NEXT
 * `triggerCallbacks` / `latestApiCallRequestId` reflects only what happens
 * after this point. `send.mockClear()` alone is insufficient — the recorded
 * `sentMessages` array is a closure buffer the spy does not own.
 */
function drainSent(wc: MockWc): void {
  wc.sentMessages.length = 0
  wc.send.mockClear()
}

/** Flush the microtask queue so a fire-and-forget dispose tail settles. */
async function flush(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe('bridge-router — many-to-many binding of one simulator webContents to multiple app sessions', () => {
  it('forwards PAGE_LIFECYCLE to the session it names, for BOTH sessions sharing one simulator wc', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    void ctx

    const A = await spawnSession(simulatorWc, { pagePath: ROOT_A })
    const B = await spawnSession(simulatorWc, { pagePath: ROOT_B })

    emitPageLifecycle(simulatorWc, { appSessionId: A.result.appSessionId, bridgeId: A.result.bridgeId, event: 'pageHide' })
    emitPageLifecycle(simulatorWc, { appSessionId: B.result.appSessionId, bridgeId: B.result.bridgeId, event: 'pageHide' })

    const pageHideCount = (wc: MockWc, bridgeId: string): number => wc.sentMessages.filter(m =>
      m.channel === C.TO_SERVICE
      && (m.payload as { msg: { type: string; body: { bridgeId: string } } }).msg?.type === 'pageHide'
      && (m.payload as { msg: { body: { bridgeId: string } } }).msg.body.bridgeId === bridgeId).length

    expect(pageHideCount(A.serviceWc, A.result.bridgeId), 'PAGE_LIFECYCLE naming A must reach A\'s service host').toBe(1)
    expect(pageHideCount(B.serviceWc, B.result.bridgeId), 'PAGE_LIFECYCLE naming B must reach B\'s service host').toBe(1)
  })

  it('routes an API_RESPONSE to the pending call\'s owning session for BOTH sessions sharing the wc', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    void ctx

    const A = await spawnSession(simulatorWc, { pagePath: ROOT_A })
    const B = await spawnSession(simulatorWc, { pagePath: ROOT_B })

    forwardAudioListen(A.serviceWc, A.result.bridgeId, { success: 'a-success', complete: 'a-complete', fail: 'a-fail' })
    const aRequestId = latestApiCallRequestId(simulatorWc)
    forwardAudioListen(B.serviceWc, B.result.bridgeId, { success: 'b-success', complete: 'b-complete', fail: 'b-fail' })
    const bRequestId = latestApiCallRequestId(simulatorWc)

    drainSent(A.serviceWc)
    drainSent(B.serviceWc)

    apiResponseFrom(simulatorWc, aRequestId, A.result.appSessionId, { event: 'canplay' })
    expect(
      triggerCallbacks(A.serviceWc).map(c => c.id),
      'the shared wc\'s response for A\'s requestId must reach A\'s service host even while B is alive on the same wc',
    ).toContain('a-success')

    apiResponseFrom(simulatorWc, bRequestId, B.result.appSessionId, { event: 'canplay' })
    expect(
      triggerCallbacks(B.serviceWc).map(c => c.id),
      'the shared wc\'s response for B\'s requestId must reach B\'s service host — ownership routes by the pending call, not by which session is latest',
    ).toContain('b-success')
  })

  it('keeps a persistent audioListen subscription alive for the OLDER session while a newer session shares the wc, without ever settling it', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    void ctx

    const A = await spawnSession(simulatorWc, { pagePath: ROOT_A })
    forwardAudioListen(A.serviceWc, A.result.bridgeId, { success: 'a-success', complete: 'a-complete', fail: 'a-fail' })
    const aRequestId = latestApiCallRequestId(simulatorWc)

    // B spawns on the SAME wc while A's audioListen subscription is still live.
    await spawnSession(simulatorWc, { pagePath: ROOT_B })

    drainSent(A.serviceWc)
    apiResponseFrom(simulatorWc, aRequestId, A.result.appSessionId, { event: 'canplay' })
    let cbs = triggerCallbacks(A.serviceWc)
    expect(cbs.map(c => c.id), 'the first audio event after B spawns on the shared wc must still reach A').toContain('a-success')
    expect(cbs.find(c => c.id === 'a-complete'), 'a persistent fire must not settle A\'s pending').toBeUndefined()

    drainSent(A.serviceWc)
    apiResponseFrom(simulatorWc, aRequestId, A.result.appSessionId, { event: 'ended' })
    cbs = triggerCallbacks(A.serviceWc)
    expect(cbs.map(c => c.id), 'a second audio event must also reach A — the subscription survives B sharing the wc').toContain('a-success')
    expect(cbs.find(c => c.id === 'a-complete'), 'a second persistent fire must still not settle A\'s pending').toBeUndefined()
  })

  it('rejects a spoofed API_RESPONSE from a simulator wc that never hosted the owning session, and still resolves the same pending from the wc that does', async () => {
    const { ctx, simulatorWc: simWc1 } = makeCtx()
    installBridgeRouter(ctx)
    void ctx

    const A = await spawnSession(simWc1, { pagePath: ROOT_A })
    await spawnSession(simWc1, { pagePath: ROOT_B })

    // A second, unrelated simulator wc hosting only C — never bound to A's session.
    const simWc2 = stubs.makeWebContents()
    await spawnSession(simWc2, { pagePath: ROOT_C })

    forwardAudioListen(A.serviceWc, A.result.bridgeId, { success: 'a-success', complete: 'a-complete', fail: 'a-fail' })
    const aRequestId = latestApiCallRequestId(simWc1)

    drainSent(A.serviceWc)
    apiResponseFrom(simWc2, aRequestId, A.result.appSessionId, { event: 'canplay' })
    expect(
      triggerCallbacks(A.serviceWc).map(c => c.id),
      'a simulator wc that never hosted A\'s session must not be authorized to answer A\'s pending call',
    ).not.toContain('a-success')

    // The pending survives the rejected attempt: the SAME requestId, answered
    // from the wc that actually hosts A, must still deliver.
    apiResponseFrom(simWc1, aRequestId, A.result.appSessionId, { event: 'canplay' })
    expect(
      triggerCallbacks(A.serviceWc).map(c => c.id),
      'the owning wc must still resolve the same pending after a spoof attempt was rejected',
    ).toContain('a-success')
  })

  it('re-resolves the OLDER session through the shared simulator wc once the LATEST session is disposed', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    void ctx

    const A = await spawnSession(simulatorWc, { pagePath: ROOT_A })
    const B = await spawnSession(simulatorWc, { pagePath: ROOT_B })

    forwardAudioListen(A.serviceWc, A.result.bridgeId, { success: 'a-success', complete: 'a-complete', fail: 'a-fail' })
    const aRequestId = latestApiCallRequestId(simulatorWc)

    // Dispose the LATEST session (B) — A stays alive with its pending intact.
    emitDispose(simulatorWc, { bridgeId: B.result.appSessionId })
    await flush()

    drainSent(A.serviceWc)
    apiResponseFrom(simulatorWc, aRequestId, A.result.appSessionId, { event: 'canplay' })

    expect(
      triggerCallbacks(A.serviceWc).map(c => c.id),
      'once the latest session (B) is disposed, A must become resolvable again through the shared simulator wc',
    ).toContain('a-success')
  })

  it('disposing the OLDER session leaves the LATEST session\'s binding to the shared simulator wc untouched', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    void ctx

    const A = await spawnSession(simulatorWc, { pagePath: ROOT_A })
    const B = await spawnSession(simulatorWc, { pagePath: ROOT_B })

    forwardAudioListen(B.serviceWc, B.result.bridgeId, { success: 'b-success', complete: 'b-complete', fail: 'b-fail' })
    const bRequestId = latestApiCallRequestId(simulatorWc)

    emitDispose(simulatorWc, { bridgeId: A.result.appSessionId })
    await flush()

    expect(A.serviceWindow.close, 'DISPOSE naming A must close A\'s service window').toHaveBeenCalled()
    expect(B.serviceWindow.close, 'disposing A must not touch B\'s service window').not.toHaveBeenCalled()

    drainSent(B.serviceWc)
    apiResponseFrom(simulatorWc, bRequestId, B.result.appSessionId, { event: 'canplay' })
    expect(
      triggerCallbacks(B.serviceWc).map(c => c.id),
      'B must stay resolvable and functional through the shared simulator wc after the older session is disposed',
    ).toContain('b-success')
  })

  it('rebinds cleanly to a fresh session after every prior session on the shared simulator wc is disposed', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    void ctx

    const A = await spawnSession(simulatorWc, { pagePath: ROOT_A })
    const B = await spawnSession(simulatorWc, { pagePath: ROOT_B })

    emitDispose(simulatorWc, { bridgeId: B.result.appSessionId })
    await flush()
    emitDispose(simulatorWc, { bridgeId: A.result.appSessionId })
    await flush()

    const Cs = await spawnSession(simulatorWc, { pagePath: ROOT_C })
    forwardAudioListen(Cs.serviceWc, Cs.result.bridgeId, { success: 'c-success', complete: 'c-complete', fail: 'c-fail' })
    const cRequestId = latestApiCallRequestId(simulatorWc)

    drainSent(Cs.serviceWc)
    apiResponseFrom(simulatorWc, cRequestId, Cs.result.appSessionId, { event: 'canplay' })
    expect(
      triggerCallbacks(Cs.serviceWc).map(c => c.id),
      'a fresh session spawned on the wc after all prior sessions were disposed must resolve normally',
    ).toContain('c-success')
  })
})
