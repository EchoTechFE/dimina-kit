/**
 * Behavior tests for bridge-router's wiring into the authoritative diagnostics
 * bus (`ctx.diagnostics`).
 *
 * Today several main-process failure paths ONLY reach `console.error`/`warn`
 * in the main-process terminal (and, for the page/logic diagnostics, a
 * `ctx.guestConsole?.emit` that is source:'service' — which `console-forward`
 * deliberately never injects, see its module header's loop-safety note) — none
 * of it reaches the embedded Console panel. `installBridgeRouter` must own ONE
 * `DiagnosticsBus` on `ctx.diagnostics` (created alongside `ctx.guestConsole` /
 * `ctx.consoleForwarder`, disposed the same way via `ctx.registry`), and route
 * every one of these failure points through it with a stable machine `code` so
 * a future Console-panel injection (and any other consumer) has one place to
 * subscribe.
 *
 * Harness mirrors bridge-router-missing-page-guard.test.ts (fetch mock +
 * manifest fixture) and bridge-router-app-lifecycle.test.ts (SERVICE_INVOKE
 * dispatch for serviceHostError/consoleLog), driving the REAL
 * installBridgeRouter through its ipcMain emitters under a hoisted electron
 * mock — no UI, no real windows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConnectionRegistry, DisposableRegistry } from '@dimina-kit/electron-deck/main'

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
    return {
      ...em,
      webContents: makeWebContents(),
      destroyed: false,
      isDestroyed() { return this.destroyed },
      close: vi.fn(),
      loadURL: vi.fn(() => Promise.resolve()),
      loadFile: vi.fn(() => Promise.resolve()),
    }
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

  return { onListeners, invokeHandlers, wcById, makeEmitter, makeWebContents, makeBrowserWindow, createWindowForSpawn, createdWindows, reset }
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

// Pooling is OFF in this suite — every spawn takes the fresh-window path.
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
import type { MessageEnvelope, ServiceInvokePayload, SpawnRequest, SpawnResult } from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'

type AnyFn = (...args: unknown[]) => unknown
type MockWc = ReturnType<typeof stubs.makeWebContents>
type MockWin = ReturnType<typeof stubs.makeBrowserWindow>

const APP_ID = 'test-app'
const ENTRY_PAGE = 'pages/index/index'
const OTHER_PAGE = 'pages/other/other'
const BAD_PAGE = 'pages/removed/removed'

/** Structural mirror of the not-yet-existing DiagnosticsBus/Diagnostic shapes
 * (contract 1). Kept local so this file exercises bridge-router's WIRING
 * without importing that module directly. */
interface DiagnosticEntry {
  severity: 'error' | 'warn' | 'info'
  code: string
  message: string
  appSessionId?: string
  ts: number
}
interface DiagnosticsBusLike {
  report(d: unknown): void
  subscribe(sink: (d: DiagnosticEntry) => void, opts?: { replay?: boolean }): { dispose(): void }
  dispose(): void | Promise<void>
}

let installBridgeRouter: typeof import('./bridge-router.js').installBridgeRouter

let originalFetch: typeof globalThis.fetch

beforeEach(async () => {
  delete process.env.DIMINA_PREWARM_POOL_SIZE
  delete process.env.DIMINA_PREWARM_DISABLE
  vi.resetModules()
  stubs.reset()
  originalFetch = globalThis.fetch
  ;({ installBridgeRouter } = await import('./bridge-router.js'))
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
}
function failResponse(status: number): Response {
  return { ok: false, status, json: async () => ({}), text: async () => 'error' } as unknown as Response
}

interface AppConfigFixture { entryPagePath?: string; pages?: string[] }
type AppConfigMode = { kind: 'ok'; fixture: AppConfigFixture } | { kind: 'fail-status' } | { kind: 'throw' }
type LogicMode = 'ok' | 'fail'

function installFetchMock(appConfig: AppConfigMode, logic: LogicMode): void {
  globalThis.fetch = vi.fn((input: string | URL | Request) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (href.includes('app-config.json')) {
      if (appConfig.kind === 'ok') return Promise.resolve(okResponse({ app: { entryPagePath: appConfig.fixture.entryPagePath, pages: appConfig.fixture.pages } }))
      if (appConfig.kind === 'fail-status') return Promise.resolve(failResponse(500))
      return Promise.reject(new Error('network down'))
    }
    if (href.includes('logic.js')) {
      return logic === 'ok'
        ? Promise.resolve({ ok: true, status: 200, text: async () => '/* logic */', json: async () => ({}) } as unknown as Response)
        : Promise.resolve(failResponse(404))
    }
    return Promise.resolve(okResponse({}))
  }) as unknown as typeof fetch
}

function makeCtx(): { ctx: WorkbenchContext; simulatorWc: MockWc } {
  const simulatorWc = stubs.makeWebContents()
  const ctx = {
    registry: new DisposableRegistry(),
    simulatorApis: { has: (_name: string) => false, invoke: async () => ({}) },
    windows: { mainWindow: { webContents: simulatorWc } },
    workspace: { getSession: () => undefined },
    connections: createConnectionRegistry(),
  } as unknown as WorkbenchContext
  return { ctx, simulatorWc }
}

/** Reads `ctx.diagnostics` — the new field this suite guards. Throws with a
 * clear message (not a cryptic undefined-call) when it is not installed. */
function diagnosticsOf(ctx: WorkbenchContext): DiagnosticsBusLike {
  const bus = (ctx as unknown as { diagnostics?: DiagnosticsBusLike }).diagnostics
  if (!bus) throw new Error('ctx.diagnostics was not installed by installBridgeRouter')
  return bus
}

function captureDiagnostics(ctx: WorkbenchContext): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []
  diagnosticsOf(ctx).subscribe((d) => { entries.push(d) }, { replay: false })
  return entries
}

async function spawnSession(simulatorWc: MockWc, pagePath: string, appId = APP_ID): Promise<{ result: SpawnResult; serviceWc: MockWc; serviceWindow: MockWin }> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  const req: SpawnRequest = { appId, pagePath, resourceBaseUrl: 'http://127.0.0.1:1/' }
  const result = (await (handle as AnyFn)({ sender: simulatorWc }, req)) as SpawnResult
  const serviceWc = stubs.wcById.get(result.serviceWcId) as MockWc | undefined
  if (!serviceWc) throw new Error(`no mock webContents with id ${result.serviceWcId}`)
  const serviceWindow = stubs.createdWindows.find(w => w.webContents.id === result.serviceWcId)
  if (!serviceWindow) throw new Error('spawned service window not found')
  return { result, serviceWc, serviceWindow }
}

async function flush(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

function emitOn(channel: string, sender: unknown, payload: unknown): void {
  const fns = stubs.onListeners.get(channel)
  if (!fns) throw new Error(`no ipcMain.on listener for ${channel}`)
  for (const fn of [...fns]) fn({ sender }, payload)
}

function sendServiceInvoke(serviceWc: MockWc, bridgeId: string, msg: MessageEnvelope): void {
  const payload: ServiceInvokePayload = { bridgeId, msg }
  emitOn(C.SERVICE_INVOKE, serviceWc, payload)
}

function sendInvokeAPI(serviceWc: MockWc, bridgeId: string, name: string, params: Record<string, unknown>): void {
  sendServiceInvoke(serviceWc, bridgeId, { type: 'invokeAPI', target: 'container', body: { name, params } })
}

function triggerCallbacks(serviceWc: MockWc): Array<{ id: unknown; args: unknown }> {
  return serviceWc.sentMessages
    .filter(m => m.channel === C.TO_SERVICE)
    .map(m => (m.payload as { msg?: MessageEnvelope }).msg)
    .filter((m): m is MessageEnvelope => !!m && m.type === 'triggerCallback')
    .map(m => m.body as { id: unknown; args: unknown })
}

function serviceLoadResourceSent(serviceWc: MockWc): boolean {
  return serviceWc.sentMessages.some(
    m => m.channel === C.TO_SERVICE && (m.payload as { msg: { type: string } }).msg?.type === 'loadResource',
  )
}

describe('bridge-router — ctx.diagnostics installation and teardown', () => {
  it('installBridgeRouter sets ctx.diagnostics to a bus exposing report/subscribe/dispose', () => {
    const { ctx } = makeCtx()
    installBridgeRouter(ctx)

    const bus = (ctx as unknown as { diagnostics?: DiagnosticsBusLike }).diagnostics
    expect(bus, 'ctx.diagnostics must be set by installBridgeRouter').toBeDefined()
    expect(typeof bus!.report).toBe('function')
    expect(typeof bus!.subscribe).toBe('function')
    expect(typeof bus!.dispose).toBe('function')
  })

  it('disposes ctx.diagnostics when ctx.registry tears down', async () => {
    const { ctx } = makeCtx()
    installBridgeRouter(ctx)
    const bus = diagnosticsOf(ctx)

    const received: DiagnosticEntry[] = []
    bus.subscribe((d) => { received.push(d) }, { replay: false })

    await (ctx.registry as unknown as DisposableRegistry).dispose()

    // The captured bus reference (not a re-read of ctx.diagnostics) must itself
    // refuse further dispatch — proving registry teardown actually disposed the
    // SAME bus instance rather than just detaching the ctx field.
    bus.report({ severity: 'error', code: 'after-teardown', message: 'must not arrive' })
    expect(received).toHaveLength(0)
  })
})

describe('bridge-router — page-not-found diagnostic', () => {
  it('reports severity:error code:page-not-found with the wechat-devtools-style message for a missing root pagePath', async () => {
    installFetchMock({ kind: 'ok', fixture: { entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] } }, 'ok')
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const captured = captureDiagnostics(ctx)

    const { serviceWindow } = await spawnSession(simulatorWc, BAD_PAGE)
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    const entry = captured.find(d => d.code === 'page-not-found')
    expect(entry, `expected a page-not-found diagnostic; got codes: ${JSON.stringify(captured.map(d => d.code))}`).toBeDefined()
    expect(entry!.severity).toBe('error')
    expect(entry!.message).toContain(`Page[${BAD_PAGE}] not found`)
  })
})

describe('bridge-router — logic-bundle-unreachable diagnostic', () => {
  it('reports severity:error code:logic-bundle-unreachable when logic.js cannot be fetched', async () => {
    installFetchMock({ kind: 'ok', fixture: { entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE] } }, 'fail')
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const captured = captureDiagnostics(ctx)

    const { serviceWindow } = await spawnSession(simulatorWc, ENTRY_PAGE)
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    const entry = captured.find(d => d.code === 'logic-bundle-unreachable')
    expect(entry, `expected a logic-bundle-unreachable diagnostic; got codes: ${JSON.stringify(captured.map(d => d.code))}`).toBeDefined()
    expect(entry!.severity).toBe('error')
  })
})

describe('bridge-router — app-config-unreachable diagnostic', () => {
  it('reports code:app-config-unreachable on a non-2xx app-config.json response, and spawn still completes (loadResource still sent)', async () => {
    installFetchMock({ kind: 'fail-status' }, 'ok')
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const captured = captureDiagnostics(ctx)

    const { serviceWc, serviceWindow } = await spawnSession(simulatorWc, ENTRY_PAGE)
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    const entry = captured.find(d => d.code === 'app-config-unreachable')
    expect(entry, `expected an app-config-unreachable diagnostic; got codes: ${JSON.stringify(captured.map(d => d.code))}`).toBeDefined()
    expect(entry!.severity).toBe('error')
    expect(
      serviceLoadResourceSent(serviceWc),
      'a failed app-config fetch must not abort the spawn — loadResource must still be sent using the fallback manifest',
    ).toBe(true)
  })

  it('reports code:app-config-unreachable when the app-config.json fetch throws (network error, not just a bad status)', async () => {
    installFetchMock({ kind: 'throw' }, 'ok')
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const captured = captureDiagnostics(ctx)

    const { serviceWindow } = await spawnSession(simulatorWc, ENTRY_PAGE)
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    const entry = captured.find(d => d.code === 'app-config-unreachable')
    expect(entry, `expected an app-config-unreachable diagnostic on fetch throw; got codes: ${JSON.stringify(captured.map(d => d.code))}`).toBeDefined()
  })
})

describe('bridge-router — service-host-error diagnostic (coexists with wx.onError)', () => {
  it('reports code:service-host-error AND still fires the registered wx.onError callback', async () => {
    installFetchMock({ kind: 'ok', fixture: { entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE] } }, 'ok')
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const captured = captureDiagnostics(ctx)

    const { result, serviceWc } = await spawnSession(simulatorWc, ENTRY_PAGE)
    sendInvokeAPI(serviceWc, result.bridgeId, 'onError', { success: 'errCb' })
    serviceWc.sentMessages.length = 0

    sendServiceInvoke(serviceWc, result.bridgeId, { type: 'serviceHostError', target: 'container', body: { message: 'boom' } })
    await flush()

    const entry = captured.find(d => d.code === 'service-host-error')
    expect(entry, `expected a service-host-error diagnostic; got codes: ${JSON.stringify(captured.map(d => d.code))}`).toBeDefined()
    expect(entry!.severity).toBe('error')

    const fired = triggerCallbacks(serviceWc).find(c => c.id === 'errCb')
    expect(fired, 'the existing wx.onError dispatch must not be displaced by the new diagnostic').toBeDefined()
  })
})

describe('bridge-router — service-uncaught-error diagnostic (coexists with guestConsole passthrough)', () => {
  it('reports code:service-uncaught-error for a consoleLog(source:"service") container message AND still forwards it via ctx.guestConsole', async () => {
    installFetchMock({ kind: 'ok', fixture: { entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE] } }, 'ok')
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const captured = captureDiagnostics(ctx)
    const guestConsoleEntries: unknown[] = []
    ;(ctx.guestConsole as { subscribe(sink: (e: unknown) => void): void } | undefined)?.subscribe((e) => { guestConsoleEntries.push(e) })

    const { result, serviceWc } = await spawnSession(simulatorWc, ENTRY_PAGE)
    const errorBody = { source: 'service', level: 'error', args: [{ message: 'Unhandled Promise Rejection', reason: 'boom' }] }
    sendServiceInvoke(serviceWc, result.bridgeId, { type: 'consoleLog', target: 'container', body: errorBody })
    await flush()

    const entry = captured.find(d => d.code === 'service-uncaught-error')
    expect(entry, `expected a service-uncaught-error diagnostic; got codes: ${JSON.stringify(captured.map(d => d.code))}`).toBeDefined()
    expect(entry!.severity).toBe('error')

    expect(
      guestConsoleEntries.some(e => (e as { source?: string }).source === 'service'),
      'the existing ctx.guestConsole passthrough for consoleLog must not regress',
    ).toBe(true)
  })
})
