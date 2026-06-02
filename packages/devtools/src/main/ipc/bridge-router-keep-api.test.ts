/**
 * Behavior tests for the bridge-router's handling of subscription-class
 * ("persistent") simulator APIs — concretely `audioListen` (the audio DOM-event
 * bridge: canplay / play / timeupdate / ended / …).
 *
 * ── The bug being pinned (TDD red) ──────────────────────────────────────────
 * Under native-host the dimina submodule strips the service-side `keep: true`
 * flag off the params before they reach the container. So when the service asks
 * the bridge-router to forward `audioListen`, the params arrive as just
 * `{ audioId }` — `keep` is gone.
 *
 * The bridge-router currently decides "is this a persistent subscription?"
 * purely from `params.keep === true` (forwardApiCallToSimulator). With `keep`
 * stripped that is false, so the router treats `audioListen` as an ORDINARY
 * one-shot call:
 *   - it arms the 5s no-handler timeout; and
 *   - the first response tears the pending down and fires `complete`.
 * Either way the subscription dies after one (or zero) events — the later audio
 * events (`play`, `timeupdate`, `ended`) never reach the service callback.
 *
 * The contract pinned here (the fix recognises persistence BY NAME via
 * `isPersistentSimulatorApi('audioListen')`, not from a `keep` flag that is no
 * longer present):
 *   - Forwarding `audioListen` (params WITHOUT `keep`) must create a pending
 *     with NO one-shot timeout: advancing time past the 5s window must NOT fire
 *     a `fail`/`complete` "no handler (timeout)" callback.
 *   - A `{ keep: true, ok: true }` API_RESPONSE must re-fire the service-side
 *     SUCCESS callback WITHOUT firing `complete` and WITHOUT deleting the
 *     pending — so a SECOND `{ keep: true }` response fires success again.
 *
 * Seam: the REAL `installBridgeRouter` is driven through its real IPC emitters
 * (SPAWN → SERVICE_INVOKE(invokeAPI) → API_RESPONSE) under an exhaustive
 * electron mock; we observe the `triggerCallback` messages the router sends to
 * the service-host webContents (its only outward effect for a callback). The
 * test never names the router's internal pending/timer fields.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

  let nextWcId = 1000
  /** Every mock webContents created, by id — lets a test resolve the service
   * window from the `serviceWcId` a spawn returns. */
  const wcById = new Map<number, ReturnType<typeof makeWebContents>>()
  /** A mock WebContents that records every `send(channel, payload)` call. */
  function makeWebContents() {
    const em = makeEmitter()
    const sent: Array<{ channel: string; payload: unknown }> = []
    const wc = {
      ...em,
      id: nextWcId++,
      destroyed: false,
      isDestroyed() { return this.destroyed },
      getURL: () => 'about:blank',
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
    return {
      ...em,
      webContents: makeWebContents(),
      destroyed: false,
      isDestroyed() { return this.destroyed },
      close: vi.fn(function (this: { destroyed: boolean }) { this.destroyed = true }),
      loadURL: vi.fn(() => Promise.resolve()),
      loadFile: vi.fn(() => Promise.resolve()),
    }
  }

  function reset() {
    onListeners.clear()
    invokeHandlers.clear()
    wcById.clear()
    nextWcId = 1000
  }

  return { onListeners, invokeHandlers, wcById, makeEmitter, makeWebContents, makeBrowserWindow, reset }
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

// `createServiceHostWindow` (called by handleSpawn) constructs a BrowserWindow
// and navigates it; stub the window-creation module so spawn yields our mock
// window (whose webContents records `send`s) without touching real Electron.
vi.mock('../windows/service-host-window/create.js', () => ({
  serviceHostSpec: () => ({}),
  serviceHostPreloadPath: '/tmp/preload.cjs',
  SERVICE_HOST_PARTITION: 'persist:simulator',
  buildServiceHostSpawnUrl: () => 'file:///service.html',
  navigateServiceHost: vi.fn(() => Promise.resolve()),
  createServiceHostWindow: vi.fn(() => stubs.makeBrowserWindow()),
  constructServiceHostWindow: vi.fn(() => stubs.makeBrowserWindow()),
}))

import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type { ApiResponsePayload, MessageEnvelope, ServiceInvokePayload, SpawnRequest, SpawnResult } from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'

type AnyFn = (...args: unknown[]) => unknown
type MockWc = ReturnType<typeof stubs.makeWebContents>

let installBridgeRouter: typeof import('./bridge-router.js').installBridgeRouter

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  vi.useFakeTimers()
  ;({ installBridgeRouter } = await import('./bridge-router.js'))
})

afterEach(() => {
  vi.useRealTimers()
})

/** Fire an `ipcMain.on` channel as if a renderer/webview sent it. */
function emitOn(channel: string, sender: unknown, payload: unknown): void {
  const fns = stubs.onListeners.get(channel)
  if (!fns) throw new Error(`no ipcMain.on listener for ${channel}`)
  for (const fn of [...fns]) fn({ sender }, payload)
}

/** Build the minimal WorkbenchContext the bridge-router actually reads. */
function makeCtx(): { ctx: WorkbenchContext; simulatorWc: MockWc } {
  const simulatorWc = stubs.makeWebContents()
  const ctx = {
    registry: { add: (_fn: AnyFn) => {} },
    simulatorApis: { has: (_name: string) => false, invoke: async () => ({}) },
    windows: { mainWindow: { webContents: simulatorWc } },
    workspace: { getSession: () => undefined },
  } as unknown as WorkbenchContext
  return { ctx, simulatorWc }
}

/**
 * Spawn an app session and return the live service-host webContents + the
 * spawn result. `handleSpawn` is async (it awaits app-config.json over fetch,
 * which fails offline and is swallowed). Real timers are needed only briefly
 * for the spawn await; we run it under fake timers and flush microtasks.
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
  // The service window is our mock; resolve it by the serviceWcId spawn returns.
  const serviceWc = stubs.wcById.get(result.serviceWcId)
  if (!serviceWc) throw new Error(`no mock webContents with id ${result.serviceWcId}`)
  return { result, serviceWc: serviceWc as unknown as MockWc }
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

/** triggerCallback messages the router sent to the service webContents. */
function triggerCallbacks(serviceWc: MockWc): Array<{ id: unknown; args: unknown }> {
  return serviceWc.sentMessages
    .filter(m => m.channel === C.TO_SERVICE)
    .map(m => (m.payload as { msg?: MessageEnvelope }).msg)
    .filter((m): m is MessageEnvelope => !!m && m.type === 'triggerCallback')
    .map(m => m.body as { id: unknown; args: unknown })
}

/**
 * Drop everything the service webContents has recorded so the NEXT
 * `triggerCallbacks(serviceWc)` reflects only the callbacks produced after this
 * point. `send.mockClear()` alone is insufficient — the recorded `sentMessages`
 * array is a closure buffer the spy does not own, so it would otherwise keep
 * accumulating across steps.
 */
function drainSent(serviceWc: MockWc): void {
  serviceWc.sentMessages.length = 0
  serviceWc.send.mockClear()
}

describe('bridge-router — persistent (audioListen) subscriptions', () => {
  it('does NOT arm the 5s one-shot timeout for audioListen (no params.keep)', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const { result, serviceWc } = await spawnSession(simulatorWc)

    forwardAudioListen(serviceWc, result.bridgeId, { success: 'svc-success', complete: 'svc-complete', fail: 'svc-fail' })

    // Advance well past the 5s no-handler window. For a persistent subscription
    // the router must NOT fire the "no handler (timeout)" fail/complete.
    drainSent(serviceWc)
    vi.advanceTimersByTime(10_000)

    const cbs = triggerCallbacks(serviceWc)
    expect(cbs.find(c => c.id === 'svc-fail')).toBeUndefined()
    expect(cbs.find(c => c.id === 'svc-complete')).toBeUndefined()
  })

  it('treats an audioListen success response as a persistent fire (by NAME), keeping the pending alive across events', async () => {
    // This pins the response-side half of the same defect. The container's
    // run-api-async can no longer set `keep` on its responses (the submodule
    // stripped the flag upstream), so the simulator acks each audio event with a
    // plain `{ ok: true }`. The router must therefore recognise `audioListen` as
    // persistent BY NAME and NOT tear the call down on such a response — exactly
    // as it must not for the first fire, the second, and so on. Today it keys
    // persistence off `payload.keep`, so a no-keep success runs the one-shot
    // path: it fires `complete` and deletes the pending, and the SECOND audio
    // event is dropped.
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const { result, serviceWc } = await spawnSession(simulatorWc)

    forwardAudioListen(serviceWc, result.bridgeId, { success: 'svc-success', complete: 'svc-complete', fail: 'svc-fail' })

    // Recover the requestId the router assigned: it is echoed in the API_CALL it
    // sent to the simulator window.
    const apiCall = simulatorWc.sentMessages.find(m => m.channel === 'simulator:api-call')
    expect(apiCall, 'router must forward audioListen to the simulator window').toBeDefined()
    const requestId = (apiCall!.payload as { requestId: string }).requestId

    // First audio event ack — NO `keep` on the wire (the stripped reality).
    drainSent(serviceWc)
    const resp1 = { requestId, ok: true, result: { event: 'canplay' } } as ApiResponsePayload
    emitOn(C.API_RESPONSE, simulatorWc, resp1)

    let cbs = triggerCallbacks(serviceWc)
    expect(cbs.map(c => c.id)).toContain('svc-success')
    // A persistent fire must NOT settle the call → no `complete`.
    expect(cbs.find(c => c.id === 'svc-complete'), 'first audio fire must not fire complete').toBeUndefined()

    // SECOND audio event — the one the bug drops once the pending is torn down.
    drainSent(serviceWc)
    const resp2 = { requestId, ok: true, result: { event: 'ended' } } as ApiResponsePayload
    emitOn(C.API_RESPONSE, simulatorWc, resp2)

    cbs = triggerCallbacks(serviceWc)
    const successFire = cbs.find(c => c.id === 'svc-success')
    expect(successFire, 'second audio fire must re-deliver success (pending not torn down)').toBeDefined()
    expect((successFire!.args as { event?: string }).event).toBe('ended')
    expect(cbs.find(c => c.id === 'svc-complete'), 'second audio fire must not fire complete').toBeUndefined()
  })
})
