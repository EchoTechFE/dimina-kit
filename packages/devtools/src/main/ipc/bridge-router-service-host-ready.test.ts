/**
 * bridge-router — `ServiceHostReadyEvent` / `onServiceHostReady`.
 *
 * Fixes a real production bug: the right-panel DevTools attach
 * (`native-simulator-devtools-host.ts`) used to poll `ctx.bridge.getServiceWc`
 * on a fixed 20×50ms (1s) retry budget, silently and PERMANENTLY giving up if
 * the service host wasn't resolvable within that window — which real machine
 * load was confirmed (via reproduction + timing instrumentation) to exceed.
 * This event fires the moment the service host's `service.html` document
 * `did-finish-load`'s — the exact instant `getServiceWc`/`serviceWcId`
 * becomes GUARANTEED resolvable — so a consumer no longer needs to guess a
 * retry budget at all.
 *
 * Pinned contract:
 *   1. `bootServiceHost` (triggered by the service host's real `did-finish-
 *      load`) emits `{ appId, appSessionId, serviceWcId }` BEFORE awaiting
 *      `injectLogicBundle` — this is service DOCUMENT readiness, not mini-app
 *      RUNTIME readiness.
 *   2. A subscriber registering AFTER the event already fired for a
 *      still-live session gets a missed-signal catch-up (async, on a
 *      microtask — never synchronously), mirroring
 *      `host-toolbar-port-channel.ts`'s `onReady` pattern.
 *   3. Catch-up is RE-VALIDATED at fire time against `appSessions` — a
 *      session disposed between the event and the catch-up microtask must
 *      not resurrect a stale attach.
 *   4. `unsubscribe()` stops delivery, including catch-up.
 *
 * Driven through the REAL `installBridgeRouter` + a REAL spawn + a manually
 * fired `'did-finish-load'` on the mock service-host wc (mirrors the harness
 * in bridge-router-storage-wxml-notify.test.ts).
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

  let nextWcId = 5000
  const wcById = new Map<number, ReturnType<typeof makeWebContents>>()
  function makeWebContents() {
    const em = makeEmitter()
    const wc = {
      ...em,
      id: nextWcId++,
      destroyed: false,
      isDestroyed() { return this.destroyed },
      getURL: () => 'about:blank',
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
    nextWcId = 5000
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
import type { SpawnRequest, SpawnResult } from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'
import type { ServiceHostReadyEvent } from './bridge-router.js'
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
    appId: APP_ID,
    pagePath: 'pages/index/index',
    resourceBaseUrl: 'http://127.0.0.1:1/',
  }
  const result = (await (handle as AnyFn)({ sender: simulatorWc }, req)) as SpawnResult
  const serviceWc = stubs.wcById.get(result.serviceWcId)
  if (!serviceWc) throw new Error(`no mock webContents with id ${result.serviceWcId}`)
  return { result, serviceWc: serviceWc as unknown as MockWc }
}

/** Fire the service host's real `'did-finish-load'`, triggering `bootServiceHost`
 * (and thus `emitServiceHostReady`) exactly like the real Electron event does. */
async function bootServiceWc(serviceWc: MockWc): Promise<void> {
  serviceWc.emit('did-finish-load')
  // bootServiceHost is async (awaits injectLogicBundle) — the emit itself is
  // synchronous, but let pending microtasks/timers settle before asserting.
  await new Promise((r) => setTimeout(r, 0))
}

describe('bridge-router — ServiceHostReadyEvent', () => {
  it('fires with { appId, appSessionId, serviceWcId } the moment the service host did-finish-loads', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const events: ServiceHostReadyEvent[] = []
    ctx.bridge!.onServiceHostReady((e) => events.push(e))

    const { result, serviceWc } = await spawnSession(simulatorWc)
    await bootServiceWc(serviceWc)

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      appId: APP_ID,
      appSessionId: result.bridgeId,
      serviceWcId: serviceWc.id,
    })
  })

  it('fires BEFORE logic injection settles (document readiness, not app-runtime readiness)', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    let fired = false
    ctx.bridge!.onServiceHostReady(() => { fired = true })

    const { serviceWc } = await spawnSession(simulatorWc)
    serviceWc.emit('did-finish-load')
    // Synchronous — the event fires before `bootServiceHost`'s first `await`
    // (injectLogicBundle) ever yields to the microtask queue.
    expect(fired).toBe(true)
  })

  it('resolving webContents.fromId(serviceWcId) is the intended consumer pattern — the event carries the exact id needed', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const events: ServiceHostReadyEvent[] = []
    ctx.bridge!.onServiceHostReady((e) => events.push(e))

    const { serviceWc } = await spawnSession(simulatorWc)
    await bootServiceWc(serviceWc)

    expect(events[0]!.serviceWcId).toBe(serviceWc.id)
  })

  it('missed-signal catch-up: a LATE subscriber (registered after the event already fired) still gets it, on a microtask', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { serviceWc } = await spawnSession(simulatorWc)
    await bootServiceWc(serviceWc)

    const events: ServiceHostReadyEvent[] = []
    ctx.bridge!.onServiceHostReady((e) => events.push(e))
    // Not yet — catch-up is scheduled on a microtask, never synchronous.
    expect(events).toHaveLength(0)

    await Promise.resolve()
    expect(events).toHaveLength(1)
    expect(events[0]!.serviceWcId).toBe(serviceWc.id)
  })

  it('does not fire (no catch-up) for a late subscriber when no session has ever booted', async () => {
    const { ctx } = makeCtx()
    installBridgeRouter(ctx)

    const events: ServiceHostReadyEvent[] = []
    ctx.bridge!.onServiceHostReady((e) => events.push(e))
    await Promise.resolve()
    await Promise.resolve()

    expect(events).toHaveLength(0)
  })

  it('unsubscribe() stops further delivery', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const events: ServiceHostReadyEvent[] = []
    const unsubscribe = ctx.bridge!.onServiceHostReady((e) => events.push(e))
    unsubscribe()

    const { serviceWc } = await spawnSession(simulatorWc)
    await bootServiceWc(serviceWc)

    expect(events).toHaveLength(0)
  })

  it('a listener that throws does not stop OTHER listeners from being notified', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const events: ServiceHostReadyEvent[] = []
    ctx.bridge!.onServiceHostReady(() => { throw new Error('boom') })
    ctx.bridge!.onServiceHostReady((e) => events.push(e))

    const { serviceWc } = await spawnSession(simulatorWc)
    await expect(bootServiceWc(serviceWc)).resolves.not.toThrow()

    expect(events).toHaveLength(1)
  })
})
