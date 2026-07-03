/**
 * Session runtime status machine — teardown must not leak timers or listeners.
 *
 * A disposed app session must not go on to fire runtime-status events for a
 * session that no longer exists:
 *
 *  1. The `LAUNCH_TIMEOUT_MS` watchdog armed at spawn must be cleared by
 *     `disposeAppSession` — advancing a fake clock past the deadline AFTER
 *     disposal must produce no `launch-failed`/`timeout` push.
 *  2. The service-host webContents' `render-process-gone` listener installed
 *     at spawn must be detached by `disposeAppSession` — the listener count
 *     for that event on the (mock) webContents must drop to 0, and emitting
 *     the event post-dispose must not push a `crashed` phase.
 *
 * Harness mirrors bridge-router-registry-no-leak.test.ts (uses the real
 * `ctx.bridge.disposeSessionsForSimulator` teardown path — the same one a
 * project close/switch drives in production — instead of reaching into
 * `disposeAppSession` directly, which isn't exported).
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

  let nextWcId = 13000
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
      close: vi.fn(function (this: { destroyed: boolean }) { this.destroyed = true }),
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
    nextWcId = 13000
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
function installFetchMock(): void {
  globalThis.fetch = vi.fn((input: string | URL | Request) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (href.includes('app-config.json')) return Promise.resolve(okAppConfig())
    if (href.includes('logic.js')) {
      return Promise.resolve({ ok: true, status: 200, text: async () => '/* logic */', json: async () => ({}) } as unknown as Response)
    }
    return Promise.resolve(makeOkEmpty())
  }) as unknown as typeof fetch
}

function makeCtx(): {
  ctx: WorkbenchContext
  simulatorWc: MockWc
  notify: { sessionRuntimeStatus: ReturnType<typeof vi.fn> }
} {
  const simulatorWc = stubs.makeWebContents()
  const notify = { sessionRuntimeStatus: vi.fn() }
  const ctx = {
    registry: { add: (_fn: AnyFn) => {} },
    simulatorApis: { has: (_name: string) => false, invoke: async () => ({}) },
    windows: { mainWindow: { webContents: simulatorWc } },
    workspace: { getSession: () => undefined },
    connections: createConnectionRegistry(),
    notify,
  } as unknown as WorkbenchContext
  return { ctx, simulatorWc, notify }
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

describe('session runtime status — disposeAppSession clears the launch-timeout watchdog', () => {
  it('advancing the fake clock past LAUNCH_TIMEOUT_MS AFTER disposal produces no launch-failed/timeout push', async () => {
    vi.useFakeTimers()
    installFetchMock()
    const { ctx, simulatorWc, notify } = makeCtx()
    installBridgeRouter(ctx)
    const { LAUNCH_TIMEOUT_MS } = await import('./bridge-router.js')

    await spawnSession(simulatorWc)
    await flush()

    expect(
      typeof ctx.bridge?.disposeSessionsForSimulator,
      'ctx.bridge.disposeSessionsForSimulator must be installed to drive teardown',
    ).toBe('function')
    await ctx.bridge!.disposeSessionsForSimulator!(simulatorWc.id)
    await flush()

    notify.sessionRuntimeStatus.mockClear()
    await vi.advanceTimersByTimeAsync(LAUNCH_TIMEOUT_MS)

    const calls = runtimeStatusCalls(notify)
    expect(
      calls.some(c => c.phase === 'launch-failed'),
      `a disposed session's launch-timeout watchdog must be cleared — it must never fire after disposal; got: ${JSON.stringify(calls)}`,
    ).toBe(false)
  })
})

describe('session runtime status — disposeAppSession detaches the render-process-gone listener', () => {
  it('the service webContents\' render-process-gone listener count drops to 0 after disposal', async () => {
    installFetchMock()
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { serviceWc, serviceWindow } = await spawnSession(simulatorWc)
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    const before = serviceWc.listeners['render-process-gone']?.size ?? 0
    expect(
      before,
      'installBridgeRouter must register a render-process-gone listener on the service webContents so a crash is observable',
    ).toBeGreaterThan(0)

    await ctx.bridge!.disposeSessionsForSimulator!(simulatorWc.id)
    await flush()

    const after = serviceWc.listeners['render-process-gone']?.size ?? 0
    expect(after, 'disposeAppSession must detach the render-process-gone listener it installed at spawn').toBe(0)
  })

  it('emitting render-process-gone on a disposed session\'s webContents pushes no "crashed" phase', async () => {
    installFetchMock()
    const { ctx, simulatorWc, notify } = makeCtx()
    installBridgeRouter(ctx)

    const { serviceWc, serviceWindow } = await spawnSession(simulatorWc)
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    await ctx.bridge!.disposeSessionsForSimulator!(simulatorWc.id)
    await flush()
    notify.sessionRuntimeStatus.mockClear()

    serviceWc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    await flush()

    const calls = runtimeStatusCalls(notify)
    expect(
      calls.some(c => c.phase === 'crashed'),
      `a stale render-process-gone on a disposed session must not push "crashed"; got: ${JSON.stringify(calls)}`,
    ).toBe(false)
  })
})
