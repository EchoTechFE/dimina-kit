/**
 * bridge-router — `storageChanged` / `wxmlChanged` container-message routing
 * (final-contract.md §3).
 *
 * Pinned contract (both cases MUST trust the SENDER-resolved identity, never
 * anything embedded in the message body — a compromised/buggy guest could
 * otherwise attribute a write to the wrong app or a DOM mutation to the wrong
 * page):
 *
 *   1. A service-host `storageChanged` container message (posted by
 *      `sync-api-patch`'s SYNC storage notify) calls
 *      `ctx.onServiceStorageChanged(ap.appId, body)` — using the app session
 *      resolved from the SENDING webContents (`ap.appId`), NOT any `appId`
 *      field that may be present in the message body.
 *
 *   2. A render-guest `wxmlChanged` container message (posted by the guest's
 *      debounced MutationObserver) emits a RenderEvent
 *      `{ kind:'domMutated', appId: ap.appId, bridgeId: page.bridgeId }` via
 *      `ctx.bridge.onRenderEvent` — using the page resolved from the SENDING
 *      webContents (`page.bridgeId`), NOT any `bridgeId` field in the body.
 *
 * Driven through the REAL `installBridgeRouter` + its real IPC emitters
 * (SPAWN → SERVICE_INVOKE / RENDER_INVOKE), mirroring the harness in
 * bridge-router-debugtap.test.ts (which exercises the same dispatch
 * chokepoint for a different concern).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoisted electron stub state (mirrors bridge-router-debugtap.test.ts) ─────
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
import type { MessageEnvelope, SpawnRequest, SpawnResult } from '../../shared/bridge-channels.js'
import type { SyncStorageChange } from '../../shared/ipc-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'
import type { RenderEvent } from './bridge-router.js'
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
    simulatorApis: { has: (_name: string) => false, invoke: async () => ({}) },
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

/** Bind a fresh render-guest webContents to `bridgeId` via a benign RENDER_INVOKE. */
function bindRenderWc(bridgeId: string): MockWc {
  const renderWc = stubs.makeWebContents()
  const msg: MessageEnvelope = { type: 'domReady', target: 'container', body: {} }
  emitOn(C.RENDER_INVOKE, renderWc, { bridgeId, msg })
  return renderWc
}

describe('bridge-router — storageChanged container message (final-contract §3)', () => {
  it('calls ctx.onServiceStorageChanged with the SENDER-resolved appId, ignoring an appId embedded in the body', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const { result, serviceWc } = await spawnSession(simulatorWc)

    const change = { op: 'set', key: `${APP_ID}_k`, value: 'v' } as SyncStorageChange
    const msg: MessageEnvelope = {
      type: 'storageChanged',
      target: 'container',
      body: { ...change, appId: 'NOT-THE-REAL-APP-ID' },
    }
    emitOn(C.SERVICE_INVOKE, serviceWc, { bridgeId: result.bridgeId, msg })

    expect(ctx.onServiceStorageChanged).toHaveBeenCalledTimes(1)
    expect(ctx.onServiceStorageChanged).toHaveBeenCalledWith(
      APP_ID,
      { ...change, appId: 'NOT-THE-REAL-APP-ID' },
    )
  })

  it('is a no-op (never throws) when ctx.onServiceStorageChanged is not wired (default dimina-fe path)', async () => {
    const { ctx, simulatorWc } = makeCtx()
    delete (ctx as { onServiceStorageChanged?: unknown }).onServiceStorageChanged
    installBridgeRouter(ctx)
    const { result, serviceWc } = await spawnSession(simulatorWc)

    const msg: MessageEnvelope = {
      type: 'storageChanged',
      target: 'container',
      body: { op: 'clear' },
    }
    expect(() => {
      emitOn(C.SERVICE_INVOKE, serviceWc, { bridgeId: result.bridgeId, msg })
    }).not.toThrow()
  })
})

describe('bridge-router — wxmlChanged container message (final-contract §3)', () => {
  it('emits a domMutated RenderEvent using the SENDER-resolved bridgeId, ignoring a bridgeId embedded in the body', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const events: RenderEvent[] = []
    ctx.bridge!.onRenderEvent((e) => events.push(e))

    const { result } = await spawnSession(simulatorWc)
    const renderWc = bindRenderWc(result.bridgeId)

    const msg: MessageEnvelope = {
      type: 'wxmlChanged',
      target: 'container',
      body: { bridgeId: 'NOT-THE-REAL-BRIDGE-ID' },
    }
    emitOn(C.RENDER_INVOKE, renderWc, { bridgeId: result.bridgeId, msg })

    const hit = events.find((e) => e.kind === 'domMutated')
    expect(hit, 'a domMutated RenderEvent must have been emitted').toBeDefined()
    expect(hit).toEqual({ kind: 'domMutated', appId: APP_ID, bridgeId: result.bridgeId })
  })

  it('never leaks a body-supplied bridgeId into the emitted event, even for a completely bogus value', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const events: RenderEvent[] = []
    ctx.bridge!.onRenderEvent((e) => events.push(e))

    const { result } = await spawnSession(simulatorWc)
    const renderWc = bindRenderWc(result.bridgeId)

    const msg: MessageEnvelope = {
      type: 'wxmlChanged',
      target: 'container',
      body: { bridgeId: '__proto__', extra: 'garbage' },
    }
    emitOn(C.RENDER_INVOKE, renderWc, { bridgeId: result.bridgeId, msg })

    const domMutated = events.filter((e) => e.kind === 'domMutated')
    expect(domMutated).toHaveLength(1)
    expect(domMutated[0]!.bridgeId).toBe(result.bridgeId)
    expect(domMutated[0]!.bridgeId).not.toBe('__proto__')
  })
})
