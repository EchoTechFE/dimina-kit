/**
 * bridge-router — SERVICE_INVOKE page routing.
 *
 * A service host serves the session's whole page stack and outlives any
 * single page in it, so `ServiceInvokePayload` carries no page identity of
 * its own (see `bridge-channels.ts`). Routing is resolved on receipt:
 *
 *   - The session is identified by the sending webContents (`appByWc`).
 *   - A message that names a page (`msg.body.bridgeId`, via `pageFromMsg`)
 *     routes there.
 *   - A message that names no page routes to the session's current active
 *     page (`activePageOf` — the ACTIVE_PAGE-elected page, or the root page
 *     while it's still alive).
 *   - When the session has no live page left, the call is dropped without
 *     throwing — there is nowhere left to route it.
 *
 * Driven through the REAL `installBridgeRouter` + its real IPC emitters
 * (SPAWN / PAGE_OPEN / ACTIVE_PAGE / PAGE_CLOSE / SERVICE_INVOKE), mirroring
 * the harness in bridge-router-active-page-on-bind.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoisted electron stub state (mirrors bridge-router-active-page-on-bind.test.ts) ─────
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
      listenerCount(event: string) { return listeners[event]?.size ?? 0 },
      emit(event: string, ...a: unknown[]) { for (const fn of [...(listeners[event] ?? [])]) fn(...a) },
    }
    return api
  }

  let nextWcId = 4000
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
    nextWcId = 4000
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

vi.mock('@dimina-kit/electron-runtime/main/service-host-window', () => ({
  serviceHostSpec: () => ({}),
  serviceHostPreloadPath: '/tmp/preload.cjs',
  SERVICE_HOST_PARTITION: 'persist:simulator',
  buildServiceHostSpawnUrl: () => 'file:///service.html',
  navigateServiceHost: vi.fn(() => Promise.resolve()),
  createServiceHostWindow: vi.fn(() => stubs.makeBrowserWindow()),
  constructServiceHostWindow: vi.fn(() => stubs.makeBrowserWindow()),
}))

import { BRIDGE_CHANNELS as C, SIMULATOR_EVENTS as E } from '../../shared/bridge-channels.js'
import type {
  MessageEnvelope,
  PageClosePayload,
  PageOpenRequest,
  PageOpenResult,
  ServiceInvokePayload,
  SpawnRequest,
  SpawnResult,
} from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'
import { installBridgeRouter } from './bridge-router.js'

type AnyFn = (...args: unknown[]) => unknown
type MockWc = ReturnType<typeof stubs.makeWebContents>

const APP_ID = 'demo-app'

beforeEach(() => {
  stubs.reset()
})

afterEach(() => {
  vi.clearAllMocks()
})

/** Fire an `ipcMain.on` channel as if a renderer/webview/service-host sent it. */
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
    simulatorApis: { has: (_name: string) => false, invoke: async () => ({}), list: () => [] },
    windows: { mainWindow: { webContents: simulatorWc } },
    workspace: { getSession: () => undefined },
    onServiceStorageChanged: vi.fn(),
  } as unknown as WorkbenchContext
  return { ctx, simulatorWc }
}

async function spawnSession(simulatorWc: MockWc): Promise<{ result: SpawnResult; serviceWc: MockWc }> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  const req: SpawnRequest = {
    appId: APP_ID,
    pagePath: 'pages/index/index',
    resourceBaseUrl: 'http://127.0.0.1:1/',
  }
  const result = (await (handle as AnyFn)({ sender: simulatorWc }, req)) as SpawnResult
  const serviceWc = stubs.wcById.get(result.serviceWcId)
  if (!serviceWc) throw new Error(`no mock webContents with id ${result.serviceWcId}`)
  return { result, serviceWc: serviceWc as unknown as MockWc }
}

/** Open a second-level page (non-root) via the real PAGE_OPEN handler. */
async function openPage(simulatorWc: MockWc, appSessionId: string, pagePath: string): Promise<PageOpenResult> {
  const handle = stubs.invokeHandlers.get(C.PAGE_OPEN)
  if (!handle) throw new Error('PAGE_OPEN handler not registered')
  const req: PageOpenRequest = { appSessionId, pagePath }
  return (await (handle as AnyFn)({ sender: simulatorWc }, req)) as PageOpenResult
}

/** Close a page via the real PAGE_CLOSE handler. */
function closePage(simulatorWc: MockWc, bridgeId: string): void {
  const payload: PageClosePayload = { bridgeId }
  emitOn(C.PAGE_CLOSE, simulatorWc, payload)
}

/**
 * Send an `invokeAPI` SERVICE_INVOKE that names no page — the fallback shape
 * used only when routing has to fall through to the session's active page.
 * Production `invokeMessage` always writes `bridgeId` (see
 * `dimina/fe/packages/service/src/api/common/index.js`); this omits it to
 * exercise that fallback path in isolation.
 */
function invokeApiFromServiceHost(serviceWc: MockWc, name: string): void {
  const msg: MessageEnvelope = { type: 'invokeAPI', target: 'container', body: { name, params: {} } }
  const payload: ServiceInvokePayload = { msg }
  emitOn(C.SERVICE_INVOKE, serviceWc, payload)
}

/** Send an `invokeAPI` SERVICE_INVOKE naming a specific page via `msg.body.bridgeId` — the production shape. */
function invokeApiFromServiceHostFor(serviceWc: MockWc, name: string, bridgeId: string): void {
  const msg: MessageEnvelope = { type: 'invokeAPI', target: 'container', body: { name, bridgeId, params: {} } }
  const payload: ServiceInvokePayload = { msg }
  emitOn(C.SERVICE_INVOKE, serviceWc, payload)
}

/** Send a `domReady` SERVICE_INVOKE naming a specific page via `msg.body.bridgeId` (matches render/runtime.js). */
function sendDomReadyFor(serviceWc: MockWc, bridgeId: string): void {
  const msg: MessageEnvelope = { type: 'domReady', target: 'container', body: { bridgeId } }
  const payload: ServiceInvokePayload = { msg }
  emitOn(C.SERVICE_INVOKE, serviceWc, payload)
}

describe('bridge-router — SERVICE_INVOKE page routing', () => {
  it('routes a page-less call to the session\'s active page, even after the launch page is gone', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { result: root, serviceWc } = await spawnSession(simulatorWc)
    const detail = await openPage(simulatorWc, root.appSessionId, 'pages/detail/detail')
    emitOn(C.ACTIVE_PAGE, simulatorWc, { appSessionId: root.appSessionId, bridgeId: detail.bridgeId })

    // Models reLaunch/redirectTo tearing down the launch page — the service
    // host has no page identity of its own, so this must not affect routing.
    closePage(simulatorWc, root.bridgeId)

    invokeApiFromServiceHost(serviceWc, 'navigateTo')

    const navActionSends = simulatorWc.sentMessages.filter(m => m.channel === E.NAV_ACTION)
    expect(navActionSends).toHaveLength(1)
    expect(navActionSends[0]!.payload).toMatchObject({
      appSessionId: root.appSessionId,
      bridgeId: detail.bridgeId,
      name: 'navigateTo',
    })
  })

  it('routes to the page the message names, even when a different page is active', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { result: root, serviceWc } = await spawnSession(simulatorWc)
    const detail = await openPage(simulatorWc, root.appSessionId, 'pages/detail/detail')
    emitOn(C.ACTIVE_PAGE, simulatorWc, { appSessionId: root.appSessionId, bridgeId: detail.bridgeId })

    // Root is alive but not active; a message naming it explicitly must still
    // land there instead of falling through to the active page.
    sendDomReadyFor(serviceWc, root.bridgeId)

    const domReadySends = simulatorWc.sentMessages.filter(m => m.channel === E.DOM_READY)
    expect(domReadySends).toHaveLength(1)
    expect(domReadySends[0]!.payload).toEqual({ bridgeId: root.bridgeId })
  })

  it('drops the call without throwing once the session has no live page left', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { result: root, serviceWc } = await spawnSession(simulatorWc)
    const detail = await openPage(simulatorWc, root.appSessionId, 'pages/detail/detail')
    emitOn(C.ACTIVE_PAGE, simulatorWc, { appSessionId: root.appSessionId, bridgeId: detail.bridgeId })

    // Both pages torn down: no ACTIVE_PAGE-elected page remains, and the root
    // fallback is gone too — there is nowhere left to route to.
    closePage(simulatorWc, root.bridgeId)
    closePage(simulatorWc, detail.bridgeId)

    expect(() => invokeApiFromServiceHost(serviceWc, 'navigateTo')).not.toThrow()

    const navActionSends = simulatorWc.sentMessages.filter(m => m.channel === E.NAV_ACTION)
    expect(navActionSends).toHaveLength(0)
  })

  it('routes a call naming the new page even before it has been elected active (reLaunch window)', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { result: root, serviceWc } = await spawnSession(simulatorWc)

    // Mirrors doReLaunch: open the new page first, but don't elect it active
    // yet — ACTIVE_PAGE only fires from a React effect after the frame mounts.
    const detail = await openPage(simulatorWc, root.appSessionId, 'pages/detail/detail')

    // Then the old (root) page is torn down, clearing activeBridgeId with no
    // root fallback left either — the session has no `activePageOf` result,
    // even though `detail` is alive and named right in the message.
    closePage(simulatorWc, root.bridgeId)

    invokeApiFromServiceHostFor(serviceWc, 'navigateTo', detail.bridgeId)

    const navActionSends = simulatorWc.sentMessages.filter(m => m.channel === E.NAV_ACTION)
    expect(navActionSends).toHaveLength(1)
    expect(navActionSends[0]!.payload).toMatchObject({
      appSessionId: root.appSessionId,
      bridgeId: detail.bridgeId,
      name: 'navigateTo',
    })
  })
})
