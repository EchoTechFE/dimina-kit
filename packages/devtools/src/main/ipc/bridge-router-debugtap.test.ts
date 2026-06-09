/**
 * Integration test for the bridge-router's flag-gated debugTap (foundation.md
 * §7) wired onto the live cross-wc bridge message stream.
 *
 * ── The contract being pinned ───────────────────────────────────────────────
 * The bridge-router records every ingress bridge message (SERVICE_INVOKE /
 * SERVICE_PUBLISH / RENDER_INVOKE / RENDER_PUBLISH / API_RESPONSE) into
 * `ctx.bridge.debugTap` — but ONLY when `DIMINA_DEBUG_TAP=1` is set at install
 * time (the flag is read once via `resolveDebugTapEnabled`). The recorder runs
 * at the TOP of each handler (before any routing / sender validation), so the
 * tap reflects the raw inbound stream attributed to the sending connection.
 *
 * Three behaviors are asserted through the REAL `installBridgeRouter` driven by
 * its real IPC emitters (SPAWN → SERVICE_INVOKE) under an exhaustive electron
 * mock, with the REAL connection registry (so spawn binds the serviceWc):
 *
 *   1. ON: with the env var set before install, `ctx.bridge.debugTap` is defined
 *      and `.enabled === true`.
 *
 *   2. ON-records: driving a SERVICE_INVOKE from the service-host wc records at
 *      least one entry whose `channel` is the bridge channel constant, whose
 *      `direction` is 'in', and whose `connectionId` equals the sending wc's id.
 *
 *   3. OFF (default, env unset): `.enabled === false` and driving the SAME
 *      SERVICE_INVOKE records NOTHING — proving the off-path is a true no-op.
 *
 * The env is toggled BEFORE `installBridgeRouter` and the module is re-imported
 * under `vi.resetModules()` per test so each install re-reads the flag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoisted electron stub state (mirrors bridge-router-keep-api.test.ts) ─────
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

  let nextWcId = 3000
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
    nextWcId = 3000
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
import type { MessageEnvelope, ServiceInvokePayload, SpawnRequest, SpawnResult } from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

type AnyFn = (...args: unknown[]) => unknown
type MockWc = ReturnType<typeof stubs.makeWebContents>

let installBridgeRouter: typeof import('./bridge-router.js').installBridgeRouter

const PRIOR_DEBUG_TAP_ENV = process.env.DIMINA_DEBUG_TAP

/**
 * (Re)load the bridge-router module so `resolveDebugTapEnabled` re-reads the
 * env that the caller has just set. Must run AFTER the per-test env mutation.
 */
async function loadRouter(): Promise<void> {
  vi.resetModules()
  ;({ installBridgeRouter } = await import('./bridge-router.js'))
}

beforeEach(() => {
  stubs.reset()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  if (PRIOR_DEBUG_TAP_ENV === undefined) delete process.env.DIMINA_DEBUG_TAP
  else process.env.DIMINA_DEBUG_TAP = PRIOR_DEBUG_TAP_ENV
})

/** Fire an `ipcMain.on` channel as if a renderer/webview sent it. */
function emitOn(channel: string, sender: unknown, payload: unknown): void {
  const fns = stubs.onListeners.get(channel)
  if (!fns) throw new Error(`no ipcMain.on listener for ${channel}`)
  for (const fn of [...fns]) fn({ sender }, payload)
}

/** Build the minimal WorkbenchContext the bridge-router actually reads, with a
 *  REAL connection registry so spawn can acquire/bind the serviceWc (which the
 *  debugTap attributes its `appSessionId`/`connectionId` from). */
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

/**
 * Spawn an app session and return the live service-host webContents + the
 * spawn result. `handleSpawn` is async (it awaits app-config.json over fetch,
 * which fails offline and is swallowed); run it under fake timers and let the
 * microtask queue flush.
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
  const serviceWc = stubs.wcById.get(result.serviceWcId)
  if (!serviceWc) throw new Error(`no mock webContents with id ${result.serviceWcId}`)
  return { result, serviceWc: serviceWc as unknown as MockWc }
}

/** Drive a SERVICE_INVOKE (invokeAPI) from the service-host wc through the
 *  router — this hits the `tapIn(C.SERVICE_INVOKE, …)` recorder at the top of
 *  the SERVICE_INVOKE handler. */
function driveServiceInvoke(serviceWc: MockWc, bridgeId: string): void {
  const msg: MessageEnvelope = {
    type: 'invokeAPI',
    target: 'container',
    body: { name: 'getSystemInfo', params: {} },
  }
  const payload: ServiceInvokePayload = { bridgeId, msg }
  emitOn(C.SERVICE_INVOKE, serviceWc, payload)
}

describe('bridge-router — debugTap records the bridge message stream (flag-gated)', () => {
  it('(ON) exposes an enabled debugTap and records a driven SERVICE_INVOKE attributed to the sending wc', async () => {
    process.env.DIMINA_DEBUG_TAP = '1'
    await loadRouter()

    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const { result, serviceWc } = await spawnSession(simulatorWc)

    // (1) With the flag set at install time, the tap is present and enabled.
    expect(ctx.bridge, 'ctx.bridge must be wired by installBridgeRouter').toBeDefined()
    const tap = ctx.bridge!.debugTap
    expect(tap, 'ctx.bridge.debugTap must be exposed').toBeDefined()
    expect(tap!.enabled, 'debugTap must be enabled under DIMINA_DEBUG_TAP=1').toBe(true)

    // Baseline: nothing recorded purely from spawn's SERVICE_INVOKE traffic
    // (spawn issues no SERVICE_INVOKE), so the next drive is the first record.
    const before = tap!.entries().length

    // (2) Drive a real SERVICE_INVOKE from the service-host wc.
    driveServiceInvoke(serviceWc, result.bridgeId)

    const entries = tap!.entries()
    expect(entries.length, 'driving SERVICE_INVOKE must record at least one entry').toBeGreaterThan(before)

    const hit = entries.find(e => e.channel === C.SERVICE_INVOKE && e.connectionId === serviceWc.id)
    expect(hit, 'an entry for SERVICE_INVOKE attributed to the sending wc must exist').toBeDefined()
    // Assert the entry shape: channel + direction:'in' + connectionId.
    expect(hit!.channel).toBe(C.SERVICE_INVOKE)
    expect(hit!.direction).toBe('in')
    expect(hit!.connectionId).toBe(serviceWc.id)
    // The serviceWc is bound to the spawned app session, so attribution carries.
    expect(hit!.appSessionId).toBe(result.appSessionId)
  })

  it('(OFF) default: debugTap is disabled and driving the same SERVICE_INVOKE records NOTHING (true no-op)', async () => {
    delete process.env.DIMINA_DEBUG_TAP
    await loadRouter()

    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const { result, serviceWc } = await spawnSession(simulatorWc)

    expect(ctx.bridge, 'ctx.bridge must be wired by installBridgeRouter').toBeDefined()
    const tap = ctx.bridge!.debugTap
    expect(tap, 'ctx.bridge.debugTap must still be exposed when off').toBeDefined()
    expect(tap!.enabled, 'debugTap must be disabled with env unset').toBe(false)
    expect(tap!.entries(), 'off-path buffer starts empty').toHaveLength(0)

    // Drive the SAME message that the ON case recorded — the disabled recorder
    // must not append anything.
    driveServiceInvoke(serviceWc, result.bridgeId)

    expect(
      tap!.entries(),
      'a disabled debugTap must record NOTHING for the same SERVICE_INVOKE',
    ).toHaveLength(0)
  })
})
