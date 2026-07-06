/**
 * Session runtime status machine — failure legs: launch timeout, logic-bundle
 * injection failure, and a service-host process crash. Each of these is
 * TODAY silent to the UI (a `console.warn`/`ctx.diagnostics` entry at best) —
 * this suite pins that each one ALSO reaches `ctx.notify.sessionRuntimeStatus`
 * with a stable `phase`/`code` so a session stuck this way is observable.
 *
 *  1. A spawned session that never reaches 'running' within
 *     `LAUNCH_TIMEOUT_MS` must push `{ phase: 'launch-failed', code: 'timeout' }`
 *     exactly once (fake clock — the real 20s window is never actually waited
 *     out in the test).
 *  2. `bootServiceHost`'s logic.js injection failing (the existing
 *     'logic-bundle-unreachable' diagnostic path) must ALSO push
 *     `{ phase: 'launch-failed', code: 'logic-bundle-unreachable' }`.
 *  3. The service-host window's webContents firing 'render-process-gone'
 *     must push `{ phase: 'crashed', code: 'service-host-crashed' }` AND
 *     `ctx.diagnostics` must receive a matching `severity:'error'` entry with
 *     the SAME code — the diagnostics bus and the runtime-status push are two
 *     independent consumers of the same failure, neither displaces the other.
 *
 * Harness mirrors bridge-router-logic-bundle-fail-loud.test.ts (fetch-mocked
 * logic.js failure) and bridge-router-app-lifecycle.test.ts (fake timers +
 * SERVICE_INVOKE dispatch). `ctx.diagnostics` here is a minimal real-shaped
 * spy bus (report/subscribe), not the actual DiagnosticsBus module — this
 * suite only cares that installBridgeRouter's failure paths CALL it, which a
 * bare spy proves without importing the diagnostics module directly.
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

  let nextWcId = 11000
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
  function createWindowForSpawn() {
    const win = makeBrowserWindow()
    createdWindows.push(win)
    return win
  }

  function reset() {
    onListeners.clear()
    invokeHandlers.clear()
    wcById.clear()
    createdWindows.length = 0
    nextWcId = 11000
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

vi.mock('../windows/service-host-window/create.js', () => ({
  serviceHostSpec: () => ({}),
  serviceHostPreloadPath: '/tmp/preload.cjs',
  SERVICE_HOST_PARTITION: 'persist:simulator',
  buildServiceHostSpawnUrl: () => 'file:///service.html',
  navigateServiceHost: vi.fn(() => Promise.resolve()),
  createServiceHostWindow: vi.fn(() => stubs.createWindowForSpawn()),
  constructServiceHostWindow: vi.fn(() => stubs.createWindowForSpawn()),
}))

import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type { SpawnRequest, SpawnResult } from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'

type AnyFn = (...args: unknown[]) => unknown
type MockWc = ReturnType<typeof stubs.makeWebContents>
type MockWin = ReturnType<typeof stubs.makeBrowserWindow>

interface SessionRuntimeStatusPayload {
  appId: string
  phase: 'launching' | 'running' | 'launch-failed' | 'crashed'
  code?: string
  reason?: string
}

interface DiagnosticEntry {
  severity: 'error' | 'warn' | 'info'
  code: string
  message: string
  appSessionId?: string
}
interface DiagnosticsBusLike {
  report(d: DiagnosticEntry): void
  subscribe(sink: (d: DiagnosticEntry) => void): { dispose(): void }
}
function makeDiagnosticsBus(): DiagnosticsBusLike & { entries: DiagnosticEntry[] } {
  const entries: DiagnosticEntry[] = []
  const sinks = new Set<(d: DiagnosticEntry) => void>()
  return {
    entries,
    report(d) { entries.push(d); for (const s of sinks) s(d) },
    subscribe(sink) { sinks.add(sink); return { dispose: () => sinks.delete(sink) } },
  }
}

const APP_ID = 'test-app'
const ENTRY_PAGE = 'pages/index/index'

let installBridgeRouter: typeof import('./bridge-router.js').installBridgeRouter

let originalFetch: typeof globalThis.fetch

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  originalFetch = globalThis.fetch
  ;({ installBridgeRouter } = await import('./bridge-router.js'))
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.useRealTimers()
})

function okAppConfig(): Response {
  const body = { app: { entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE] } }
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
}
function makeOkEmpty(): Response {
  return { ok: true, status: 200, text: async () => '', json: async () => ({}) } as unknown as Response
}
function makeFailLogic(): Response {
  return { ok: false, status: 404, text: async () => 'Not Found', json: async () => ({}) } as unknown as Response
}

/** app-config.json always OK; logic.js mode-dependent so injection can be forced to fail. */
function installFetchMock(logic: 'ok' | 'fail'): void {
  globalThis.fetch = vi.fn((input: string | URL | Request) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (href.includes('app-config.json')) return Promise.resolve(okAppConfig())
    if (href.includes('logic.js')) {
      return logic === 'ok'
        ? Promise.resolve({ ok: true, status: 200, text: async () => '/* logic */', json: async () => ({}) } as unknown as Response)
        : Promise.resolve(makeFailLogic())
    }
    return Promise.resolve(makeOkEmpty())
  }) as unknown as typeof fetch
}

function makeCtx(): {
  ctx: WorkbenchContext
  simulatorWc: MockWc
  notify: { sessionRuntimeStatus: ReturnType<typeof vi.fn> }
  diagnostics: DiagnosticsBusLike & { entries: DiagnosticEntry[] }
} {
  const simulatorWc = stubs.makeWebContents()
  const notify = { sessionRuntimeStatus: vi.fn() }
  const diagnostics = makeDiagnosticsBus()
  const ctx = {
    registry: { add: (_fn: AnyFn) => {} },
    simulatorApis: { has: (_name: string) => false, invoke: async () => ({}) },
    windows: { mainWindow: { webContents: simulatorWc } },
    workspace: { getSession: () => undefined },
    connections: createConnectionRegistry(),
    notify,
    diagnostics,
  } as unknown as WorkbenchContext
  return { ctx, simulatorWc, notify, diagnostics }
}

async function spawnSession(
  simulatorWc: MockWc,
): Promise<{ result: SpawnResult; serviceWc: MockWc; serviceWindow: MockWin }> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  const req: SpawnRequest = { appId: APP_ID, pagePath: ENTRY_PAGE, resourceBaseUrl: 'http://127.0.0.1:1/' }
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

function runtimeStatusCalls(notify: { sessionRuntimeStatus: ReturnType<typeof vi.fn> }): SessionRuntimeStatusPayload[] {
  return notify.sessionRuntimeStatus.mock.calls.map(c => c[0] as SessionRuntimeStatusPayload)
}

describe('session runtime status — launch timeout', () => {
  it('pushes { phase: "launch-failed", code: "timeout" } once LAUNCH_TIMEOUT_MS elapses without reaching "running"', async () => {
    vi.useFakeTimers()
    installFetchMock('ok')
    const { ctx, simulatorWc, notify } = makeCtx()
    installBridgeRouter(ctx)
    const { LAUNCH_TIMEOUT_MS } = await import('./bridge-router.js')

    await spawnSession(simulatorWc)
    await flush()
    notify.sessionRuntimeStatus.mockClear()

    await vi.advanceTimersByTimeAsync(LAUNCH_TIMEOUT_MS)

    const calls = runtimeStatusCalls(notify)
    const timedOut = calls.find(c => c.phase === 'launch-failed' && c.code === 'timeout')
    expect(
      timedOut,
      `expected a launch-failed/timeout push after ${LAUNCH_TIMEOUT_MS}ms with no "running"; got: ${JSON.stringify(calls)}`,
    ).toBeDefined()
    expect(timedOut!.appId).toBe(APP_ID)
  })

  it('does NOT push launch-failed/timeout when the session already reached "running" before the deadline', async () => {
    vi.useFakeTimers()
    installFetchMock('ok')
    const { ctx, simulatorWc, notify } = makeCtx()
    installBridgeRouter(ctx)
    const { LAUNCH_TIMEOUT_MS } = await import('./bridge-router.js')

    const { result, serviceWc } = await spawnSession(simulatorWc)
    await flush()

    // Root domReady before the deadline — session reaches 'running'.
    const msg = { type: 'domReady', target: 'container', body: {} }
    const onListeners = stubs.onListeners.get(C.SERVICE_INVOKE)
    for (const fn of [...(onListeners ?? [])]) (fn as AnyFn)({ sender: serviceWc }, { bridgeId: result.bridgeId, msg })
    await flush()

    notify.sessionRuntimeStatus.mockClear()
    await vi.advanceTimersByTimeAsync(LAUNCH_TIMEOUT_MS)

    const calls = runtimeStatusCalls(notify)
    expect(
      calls.some(c => c.phase === 'launch-failed'),
      `a session that already reached "running" must never late-fire launch-failed/timeout; got: ${JSON.stringify(calls)}`,
    ).toBe(false)
  })
})

describe('session runtime status — logic-bundle injection failure', () => {
  it('pushes { phase: "launch-failed", code: "logic-bundle-unreachable" } when logic.js cannot be injected', async () => {
    installFetchMock('fail')
    const { ctx, simulatorWc, notify } = makeCtx()
    installBridgeRouter(ctx)

    const { serviceWindow } = await spawnSession(simulatorWc)
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    const calls = runtimeStatusCalls(notify)
    const failed = calls.find(c => c.phase === 'launch-failed' && c.code === 'logic-bundle-unreachable')
    expect(
      failed,
      `expected a launch-failed/logic-bundle-unreachable push; got: ${JSON.stringify(calls)}`,
    ).toBeDefined()
  })

  it('does not push launch-failed when logic.js injects successfully', async () => {
    installFetchMock('ok')
    const { ctx, simulatorWc, notify } = makeCtx()
    installBridgeRouter(ctx)

    const { serviceWindow } = await spawnSession(simulatorWc)
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    const calls = runtimeStatusCalls(notify)
    expect(calls.some(c => c.phase === 'launch-failed')).toBe(false)
  })
})

describe('session runtime status — service-host process crash', () => {
  it('pushes { phase: "crashed", code: "service-host-crashed" } when the service window webContents fires render-process-gone', async () => {
    installFetchMock('ok')
    const { ctx, simulatorWc, notify } = makeCtx()
    installBridgeRouter(ctx)

    const { serviceWc, serviceWindow } = await spawnSession(simulatorWc)
    serviceWindow.webContents.emit('did-finish-load')
    await flush()
    notify.sessionRuntimeStatus.mockClear()

    serviceWc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    await flush()

    const calls = runtimeStatusCalls(notify)
    const crashed = calls.find(c => c.phase === 'crashed' && c.code === 'service-host-crashed')
    expect(crashed, `expected a crashed/service-host-crashed push; got: ${JSON.stringify(calls)}`).toBeDefined()
    expect(crashed!.appId).toBe(APP_ID)
  })

  it('also reports a matching severity:error diagnostic with the SAME code (two independent consumers, neither displaces the other)', async () => {
    installFetchMock('ok')
    const { ctx, simulatorWc, notify, diagnostics } = makeCtx()
    installBridgeRouter(ctx)

    const { serviceWc, serviceWindow } = await spawnSession(simulatorWc)
    serviceWindow.webContents.emit('did-finish-load')
    await flush()
    notify.sessionRuntimeStatus.mockClear()
    diagnostics.entries.length = 0

    serviceWc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    await flush()

    const entry = diagnostics.entries.find(e => e.code === 'service-host-crashed')
    expect(entry, `expected a diagnostics entry code:service-host-crashed; got: ${JSON.stringify(diagnostics.entries)}`).toBeDefined()
    expect(entry!.severity).toBe('error')
    expect(
      runtimeStatusCalls(notify).some(c => c.phase === 'crashed'),
      'the diagnostics report must not displace the sessionRuntimeStatus push',
    ).toBe(true)
  })
})
