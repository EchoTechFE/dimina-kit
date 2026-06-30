/**
 * Integration tests for the bridge-router's app-lifecycle subsystem:
 *
 *   1. onError / offError: registering a wx.onError listener via invokeAPI,
 *      then sending a serviceHostError fires the callback; offError deregisters
 *      it so a SECOND error does NOT re-trigger the callback.
 *
 *   2. pageScrollTo: the handler runs the scroll script in the page's render
 *      webContents via executeJavaScript and fires success/complete callbacks.
 *
 *   3. Foreground/background driver: the mainWindow event emitter fires
 *      'minimize'/'hide' → appHide service message + onAppHide callbacks;
 *      'restore'/'show' → appShow service message + onAppShow callbacks.
 *
 * Harness: mirrors bridge-router-keep-api.test.ts — the REAL installBridgeRouter
 * is driven through its ipcMain emitters (SPAWN → SERVICE_INVOKE, RENDER_INVOKE)
 * under a hoisted electron mock. Tests observe `triggerCallback` messages sent
 * to the service-host webContents and `TO_SERVICE` messages for service events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoisted electron stub state ─────────────────────────────────────────────
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

  let nextWcId = 2000
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

  function makeBrowserWindow(mainWinOverride?: ReturnType<typeof makeEmitter>) {
    const em = mainWinOverride ?? makeEmitter()
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
    nextWcId = 2000
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
import type { MessageEnvelope, ServiceInvokePayload, SpawnRequest, SpawnResult } from '../../shared/bridge-channels.js'
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emitOn(channel: string, sender: unknown, payload: unknown): void {
  const fns = stubs.onListeners.get(channel)
  if (!fns) throw new Error(`no ipcMain.on listener for ${channel}`)
  for (const fn of [...fns]) fn({ sender }, payload)
}

/** Build a WorkbenchContext with an event-emitting mainWindow. */
function makeCtx(): { ctx: WorkbenchContext; simulatorWc: MockWc; mainWindow: ReturnType<typeof stubs.makeEmitter> } {
  const simulatorWc = stubs.makeWebContents()
  const mainWindow = stubs.makeEmitter()
  const ctx = {
    registry: { add: (_fn: AnyFn) => {} },
    connections: createConnectionRegistry(),
    simulatorApis: { has: (_name: string) => false, invoke: async () => ({}) },
    windows: { mainWindow },
    workspace: { getSession: () => undefined },
  } as unknown as WorkbenchContext
  return { ctx, simulatorWc, mainWindow }
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

function sendInvokeAPI(serviceWc: MockWc, bridgeId: string, name: string, params: Record<string, unknown>): void {
  const msg: MessageEnvelope = { type: 'invokeAPI', target: 'container', body: { name, params } }
  const payload: ServiceInvokePayload = { bridgeId, msg }
  emitOn(C.SERVICE_INVOKE, serviceWc, payload)
}

/** triggerCallback messages sent to the given service webContents. */
function triggerCallbacks(serviceWc: MockWc): Array<{ id: unknown; args: unknown }> {
  return serviceWc.sentMessages
    .filter(m => m.channel === C.TO_SERVICE)
    .map(m => (m.payload as { msg?: MessageEnvelope }).msg)
    .filter((m): m is MessageEnvelope => !!m && m.type === 'triggerCallback')
    .map(m => m.body as { id: unknown; args: unknown })
}

/** forwardToService messages sent to the service (type matches the given type). */
function serviceMessages(serviceWc: MockWc, type: string): MessageEnvelope[] {
  return serviceWc.sentMessages
    .filter(m => m.channel === C.TO_SERVICE)
    .map(m => (m.payload as { msg?: MessageEnvelope }).msg)
    .filter((m): m is MessageEnvelope => !!m && m.type === type)
}

function drainSent(serviceWc: MockWc): void {
  serviceWc.sentMessages.length = 0
  serviceWc.send.mockClear()
}

/**
 * Bind a render webContents to the page via RENDER_INVOKE so that
 * `page.renderWc` is set — required before pageScrollTo can call
 * `renderWc.executeJavaScript`.
 */
function bindRenderWc(renderWc: MockWc, bridgeId: string): void {
  const renderInvokePayload = { bridgeId, msg: { type: 'renderHostReady', target: 'container', body: {} } }
  emitOn(C.RENDER_INVOKE, renderWc, renderInvokePayload)
}

// ─── 1. onError / offError ────────────────────────────────────────────────────

describe('bridge-router — onError / offError lifecycle', () => {
  it('fires triggerCallback for the registered onError id when serviceHostError arrives', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const { result, serviceWc } = await spawnSession(simulatorWc)

    // Register an onError listener
    sendInvokeAPI(serviceWc, result.bridgeId, 'onError', { success: 'errCb' })
    drainSent(serviceWc)

    // Deliver a serviceHostError from the service webContents
    const errMsg: MessageEnvelope = { type: 'serviceHostError', target: 'container', body: { message: 'boom' } }
    emitOn(C.SERVICE_INVOKE, serviceWc, { bridgeId: result.bridgeId, msg: errMsg })

    const cbs = triggerCallbacks(serviceWc)
    const fired = cbs.find(c => c.id === 'errCb')
    expect(fired, 'onError callback must be triggered by serviceHostError').toBeDefined()
    expect((fired!.args as { message?: string } | string)).toMatchObject(
      typeof fired!.args === 'object' ? { message: 'boom' } : {},
    )
  })

  it('does NOT fire the callback after offError deregisters the listener', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const { result, serviceWc } = await spawnSession(simulatorWc)

    // Register then immediately unregister
    sendInvokeAPI(serviceWc, result.bridgeId, 'onError', { success: 'errCb' })
    sendInvokeAPI(serviceWc, result.bridgeId, 'offError', { success: 'errCb' })
    drainSent(serviceWc)

    // Another serviceHostError after the listener was removed
    const errMsg: MessageEnvelope = { type: 'serviceHostError', target: 'container', body: { message: 'second error' } }
    emitOn(C.SERVICE_INVOKE, serviceWc, { bridgeId: result.bridgeId, msg: errMsg })

    const cbs = triggerCallbacks(serviceWc)
    expect(cbs.find(c => c.id === 'errCb')).toBeUndefined()
  })
})

// ─── 2. pageScrollTo ──────────────────────────────────────────────────────────

describe('bridge-router — pageScrollTo', () => {
  it('calls renderWc.executeJavaScript with a window.scrollTo script containing the given scrollTop', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const { result, serviceWc } = await spawnSession(simulatorWc)

    // Bind a render wc to the page so page.renderWc is set
    const renderWc = stubs.makeWebContents()
    bindRenderWc(renderWc, result.bridgeId)

    drainSent(serviceWc)

    // Send pageScrollTo from the service
    sendInvokeAPI(serviceWc, result.bridgeId, 'pageScrollTo', {
      scrollTop: 120,
      duration: 300,
      success: 'okCb',
      complete: 'doneCb',
    })

    // executeJavaScript must have been called with the scroll script
    expect(renderWc.executeJavaScript).toHaveBeenCalledTimes(1)
    const script = (renderWc.executeJavaScript.mock.calls as unknown as [[string]])[0][0]
    expect(script).toContain('window.scrollTo')
    expect(script).toContain('top: 120')

    // success and complete callbacks must fire
    const cbs = triggerCallbacks(serviceWc)
    expect(cbs.find(c => c.id === 'okCb'), 'success callback must fire').toBeDefined()
    expect(cbs.find(c => c.id === 'doneCb'), 'complete callback must fire').toBeDefined()
  })

  it('still fires success/complete even when no renderWc is attached (page not loaded)', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const { result, serviceWc } = await spawnSession(simulatorWc)

    drainSent(serviceWc)

    // No render wc bound — page.renderWc is null
    sendInvokeAPI(serviceWc, result.bridgeId, 'pageScrollTo', {
      scrollTop: 50,
      success: 'okCb2',
      complete: 'doneCb2',
    })

    const cbs = triggerCallbacks(serviceWc)
    expect(cbs.find(c => c.id === 'okCb2')).toBeDefined()
    expect(cbs.find(c => c.id === 'doneCb2')).toBeDefined()
  })
})

// ─── 3. App foreground / background driver ────────────────────────────────────

describe('bridge-router — installAppLifecycleDriver (window events)', () => {
  it('sends appHide service message and fires onAppHide callbacks on mainWindow minimize', async () => {
    const { ctx, simulatorWc, mainWindow } = makeCtx()
    installBridgeRouter(ctx)
    const { result, serviceWc } = await spawnSession(simulatorWc)

    // Register an onAppHide listener
    sendInvokeAPI(serviceWc, result.bridgeId, 'onAppHide', { success: 'hideCb' })
    drainSent(serviceWc)

    // Emit 'minimize' on the mainWindow
    mainWindow.emit('minimize')

    // Expect an appHide type message forwarded to the service
    const appHideMsgs = serviceMessages(serviceWc, 'appHide')
    expect(appHideMsgs.length, 'appHide service message must be sent on minimize').toBeGreaterThan(0)

    // Expect the onAppHide callback to be triggered
    const cbs = triggerCallbacks(serviceWc)
    expect(cbs.find(c => c.id === 'hideCb'), 'onAppHide callback must fire on minimize').toBeDefined()
  })

  it('sends appShow service message and fires onAppShow callbacks on mainWindow restore', async () => {
    const { ctx, simulatorWc, mainWindow } = makeCtx()
    installBridgeRouter(ctx)
    const { result, serviceWc } = await spawnSession(simulatorWc)

    // Register an onAppShow listener
    sendInvokeAPI(serviceWc, result.bridgeId, 'onAppShow', { success: 'showCb' })
    drainSent(serviceWc)

    // Emit 'restore' on the mainWindow
    mainWindow.emit('restore')

    const appShowMsgs = serviceMessages(serviceWc, 'appShow')
    expect(appShowMsgs.length, 'appShow service message must be sent on restore').toBeGreaterThan(0)

    const cbs = triggerCallbacks(serviceWc)
    expect(cbs.find(c => c.id === 'showCb'), 'onAppShow callback must fire on restore').toBeDefined()
  })

  it('sends appHide on hide event and appShow on show event', async () => {
    const { ctx, simulatorWc, mainWindow } = makeCtx()
    installBridgeRouter(ctx)
    const { result, serviceWc } = await spawnSession(simulatorWc)

    sendInvokeAPI(serviceWc, result.bridgeId, 'onAppHide', { success: 'hideCb2' })
    sendInvokeAPI(serviceWc, result.bridgeId, 'onAppShow', { success: 'showCb2' })
    drainSent(serviceWc)

    mainWindow.emit('hide')
    const hideCallbacks = triggerCallbacks(serviceWc)
    expect(hideCallbacks.find(c => c.id === 'hideCb2')).toBeDefined()
    expect(serviceMessages(serviceWc, 'appHide').length).toBeGreaterThan(0)

    drainSent(serviceWc)

    mainWindow.emit('show')
    const showCallbacks = triggerCallbacks(serviceWc)
    expect(showCallbacks.find(c => c.id === 'showCb2')).toBeDefined()
    expect(serviceMessages(serviceWc, 'appShow').length).toBeGreaterThan(0)
  })
})
