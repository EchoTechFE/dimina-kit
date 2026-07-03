/**
 * The one-shot "no handler" watchdog that guards a forwarded API call
 * (`forwardApiCallToSimulator` in bridge-router.ts) currently arms a flat
 * `API_CALL_TIMEOUT_MS` (5000ms) for every call regardless of name or params.
 *
 * For `request` (and any other network-budget API: downloadFile, uploadFile)
 * this races the wx.request contract, whose real timeout budget is the
 * caller's `params.timeout` (default 60000ms). A slow-but-legitimate HTTP
 * round trip past 5s gets its pending entry deleted by the watchdog, and the
 * later-arriving `API_RESPONSE` (200 or 401 alike) is silently dropped
 * because `handleApiResponse` no-ops on a requestId it no longer has pending.
 *
 * Contract pinned: the watchdog window must scale with `apiCallWatchdogMs`
 * (shared/simulator-api-metadata.ts) — network-budget APIs get
 * `timeout-or-60000 + 5000` grace, everything else keeps the flat 5000ms.
 *
 * Seam: identical harness to bridge-router-api-fail-passthrough.test.ts
 * (exhaustive electron mock, real `installBridgeRouter` driven through
 * SPAWN → SERVICE_INVOKE(invokeAPI) → API_RESPONSE), plus fake timers per
 * bridge-router-keep-api.test.ts to control the watchdog clock precisely.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

  let nextWcId = 8000
  const wcById = new Map<number, ReturnType<typeof makeWebContents>>()
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
    nextWcId = 8000
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
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

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

function emitOn(channel: string, sender: unknown, payload: unknown): void {
  const fns = stubs.onListeners.get(channel)
  if (!fns) throw new Error(`no ipcMain.on listener for ${channel}`)
  for (const fn of [...fns]) fn({ sender }, payload)
}

function makeCtx(): { ctx: WorkbenchContext; simulatorWc: MockWc } {
  const simulatorWc = stubs.makeWebContents()
  const ctx = {
    registry: { add: (_fn: AnyFn) => {} },
    connections: createConnectionRegistry(),
    simulatorApis: { has: (_name: string) => false, invoke: async () => ({}) },
    windows: { mainWindow: { webContents: simulatorWc } },
    workspace: { getSession: () => undefined },
  } as unknown as WorkbenchContext
  return { ctx, simulatorWc }
}

async function spawnSession(simulatorWc: MockWc): Promise<{ result: SpawnResult; serviceWc: MockWc }> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  const req: SpawnRequest = {
    appId: 'demo-app',
    pagePath: 'pages/index/index',
    resourceBaseUrl: 'http://127.0.0.1:1/',
  }
  const result = (await (handle as AnyFn)({ sender: simulatorWc }, req)) as SpawnResult
  const serviceWc = stubs.wcById.get(result.serviceWcId)
  if (!serviceWc) throw new Error(`no mock webContents with id ${result.serviceWcId}`)
  return { result, serviceWc: serviceWc as unknown as MockWc }
}

/** Forward an arbitrary one-shot `invokeAPI` call from the service through the router. */
function forwardApiCall(
  serviceWc: MockWc,
  bridgeId: string,
  name: string,
  params: Record<string, unknown>,
  callbacks: { success?: unknown; complete?: unknown; fail?: unknown },
): void {
  const msg: MessageEnvelope = {
    type: 'invokeAPI',
    target: 'container',
    body: { name, params: { ...params, ...callbacks } },
  }
  const payload: ServiceInvokePayload = { bridgeId, msg }
  emitOn(C.SERVICE_INVOKE, serviceWc, payload)
}

/** Recover the requestId the router assigned by reading the API_CALL it forwarded to the simulator. */
function forwardedRequestId(simulatorWc: MockWc): string {
  const apiCall = simulatorWc.sentMessages.find(m => m.channel === 'simulator:api-call')
  if (!apiCall) throw new Error('router did not forward the API_CALL to the simulator window')
  return (apiCall.payload as { requestId: string }).requestId
}

function triggerCallbacks(serviceWc: MockWc): Array<{ id: unknown; args: unknown }> {
  return serviceWc.sentMessages
    .filter(m => m.channel === C.TO_SERVICE)
    .map(m => (m.payload as { msg?: MessageEnvelope }).msg)
    .filter((m): m is MessageEnvelope => !!m && m.type === 'triggerCallback')
    .map(m => m.body as { id: unknown; args: unknown })
}

async function setup(
  name: string,
  params: Record<string, unknown>,
): Promise<{ ctx: WorkbenchContext; simulatorWc: MockWc; serviceWc: MockWc; requestId: string }> {
  const { ctx, simulatorWc } = makeCtx()
  installBridgeRouter(ctx)
  const { result, serviceWc } = await spawnSession(simulatorWc)
  forwardApiCall(serviceWc, result.bridgeId, name, params, { success: 'svc-success', complete: 'svc-complete', fail: 'svc-fail' })
  const requestId = forwardedRequestId(simulatorWc)
  return { ctx, simulatorWc, serviceWc, requestId }
}

describe('bridge-router — forwarded `request` call watchdog scales with the wx timeout budget', () => {
  it('does not fail at the legacy 5s mark, and still delivers a within-budget late success (e.g. at 30s)', async () => {
    const { simulatorWc, serviceWc, requestId } = await setup('request', { url: 'https://example.com/api' })

    await vi.advanceTimersByTimeAsync(5_000)
    let cbs = triggerCallbacks(serviceWc)
    expect(cbs.find(c => c.id === 'svc-fail'), 'must not fail at the legacy 5s mark').toBeUndefined()

    await vi.advanceTimersByTimeAsync(25_000) // now 30s since the call was forwarded

    const resp: ApiResponsePayload = { appSessionId: 'demo-app', requestId, ok: true, result: { data: { a: 1 }, statusCode: 200 } }
    emitOn(C.API_RESPONSE, simulatorWc, resp)

    cbs = triggerCallbacks(serviceWc)
    const successFire = cbs.find(c => c.id === 'svc-success')
    expect(successFire, 'a within-budget late response must still be delivered (pending not torn down)').toBeDefined()
    expect(successFire!.args).toEqual({ data: { a: 1 }, statusCode: 200 })
  })

  it('fires "no handler (timeout)" only once the full 60000ms default budget + 5000ms grace elapses (65000ms), not before', async () => {
    const { serviceWc } = await setup('request', { url: 'https://example.com/api' })

    await vi.advanceTimersByTimeAsync(64_999)
    let cbs = triggerCallbacks(serviceWc)
    expect(cbs.find(c => c.id === 'svc-fail'), 'must not fire before 65000ms').toBeUndefined()

    await vi.advanceTimersByTimeAsync(1) // now exactly 65000ms
    cbs = triggerCallbacks(serviceWc)
    const failFire = cbs.find(c => c.id === 'svc-fail')
    expect(failFire, 'must fire exactly at 65000ms').toBeDefined()
    expect((failFire!.args as { errMsg?: string }).errMsg).toBe('request:fail no handler (timeout)')
  })

  it('honors an explicit params.timeout: 1000 as a 6000ms watchdog window (timeout + 5000ms grace)', async () => {
    const { serviceWc } = await setup('request', { url: 'https://example.com/api', timeout: 1000 })

    await vi.advanceTimersByTimeAsync(5_999)
    let cbs = triggerCallbacks(serviceWc)
    expect(cbs.find(c => c.id === 'svc-fail'), 'must not fire before 6000ms').toBeUndefined()

    await vi.advanceTimersByTimeAsync(1) // now exactly 6000ms
    cbs = triggerCallbacks(serviceWc)
    const failFire = cbs.find(c => c.id === 'svc-fail')
    expect(failFire, 'must fire exactly at 6000ms').toBeDefined()
    expect((failFire!.args as { errMsg?: string }).errMsg).toBe('request:fail no handler (timeout)')
  })
})

describe('bridge-router — non-network API calls keep the flat 5000ms watchdog (regression guard)', () => {
  it('a forwarded showToast call still fails "no handler (timeout)" at exactly 5000ms', async () => {
    const { serviceWc } = await setup('showToast', { title: 'hi' })

    await vi.advanceTimersByTimeAsync(4_999)
    let cbs = triggerCallbacks(serviceWc)
    expect(cbs.find(c => c.id === 'svc-fail'), 'must not fire before 5000ms').toBeUndefined()

    await vi.advanceTimersByTimeAsync(1) // now exactly 5000ms
    cbs = triggerCallbacks(serviceWc)
    const failFire = cbs.find(c => c.id === 'svc-fail')
    expect(failFire, 'must fire exactly at 5000ms').toBeDefined()
    expect((failFire!.args as { errMsg?: string }).errMsg).toBe('showToast:fail no handler (timeout)')
  })
})
