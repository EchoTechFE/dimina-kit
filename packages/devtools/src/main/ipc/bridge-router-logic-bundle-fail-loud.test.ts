/**
 * Regression tests for the fail-loud gate in bootServiceHost: a logic.js that
 * cannot be fetched must suppress loadResource (which would otherwise produce
 * the misleading "module app not found") and emit one actionable guestConsole
 * error; a successful fetch must produce loadResource and no error.
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

  let nextWcId = 5000
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
    const win = {
      ...em,
      webContents: makeWebContents(),
      destroyed: false,
      isDestroyed() { return this.destroyed },
      close: vi.fn(),
      loadURL: vi.fn(() => Promise.resolve()),
      loadFile: vi.fn(() => Promise.resolve()),
    }
    return win
  }

  const createdWindows: Array<ReturnType<typeof makeBrowserWindow>> = []
  const createWindowCallOpts: Array<Record<string, unknown>> = []

  function createWindowForSpawn(opts?: Record<string, unknown>) {
    const win = makeBrowserWindow()
    createdWindows.push(win)
    if (opts !== undefined) createWindowCallOpts.push(opts)
    return win
  }

  function reset() {
    onListeners.clear()
    invokeHandlers.clear()
    wcById.clear()
    createdWindows.length = 0
    createWindowCallOpts.length = 0
    nextWcId = 5000
  }

  return {
    onListeners, invokeHandlers, wcById,
    makeEmitter, makeWebContents, makeBrowserWindow, createWindowForSpawn,
    createdWindows, createWindowCallOpts,
    reset,
  }
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
import type { SpawnRequest, SpawnResult, RenderInvokePayload } from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { ConsoleForwarder, GuestConsoleEntry } from '../services/console-forward/index.js'

type AnyFn = (...args: unknown[]) => unknown
type MockWc = ReturnType<typeof stubs.makeWebContents>
type MockWin = ReturnType<typeof stubs.makeBrowserWindow>

const APP_ID = 'test-app'

let installBridgeRouter: typeof import('./bridge-router.js').installBridgeRouter

const PRIOR_POOL_ENV = process.env.DIMINA_PREWARM_POOL_SIZE
const PRIOR_DISABLE_ENV = process.env.DIMINA_PREWARM_DISABLE

// The original fetch before each test replaces it.
let originalFetch: typeof globalThis.fetch

beforeEach(async () => {
  // Pooling OFF: spawn takes the fresh-window path (createServiceHostWindow).
  delete process.env.DIMINA_PREWARM_POOL_SIZE
  delete process.env.DIMINA_PREWARM_DISABLE
  vi.resetModules()
  stubs.reset()
  originalFetch = globalThis.fetch
  ;({ installBridgeRouter } = await import('./bridge-router.js'))
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (PRIOR_POOL_ENV === undefined) delete process.env.DIMINA_PREWARM_POOL_SIZE
  else process.env.DIMINA_PREWARM_POOL_SIZE = PRIOR_POOL_ENV
  if (PRIOR_DISABLE_ENV === undefined) delete process.env.DIMINA_PREWARM_DISABLE
  else process.env.DIMINA_PREWARM_DISABLE = PRIOR_DISABLE_ENV
})

const OK_APP_CONFIG = {
  ok: true, status: 200,
  json: async () => ({}),
  text: async () => '{}',
} as unknown as Response

function makeOkLogic(): Response {
  return {
    ok: true, status: 200,
    text: async () => '/* logic bundle */',
    json: async () => ({}),
  } as unknown as Response
}

function makeFailLogic(): Response {
  return {
    ok: false, status: 404,
    text: async () => 'Not Found',
    json: async () => ({}),
  } as unknown as Response
}

function makeOkEmpty(): Response {
  return {
    ok: true, status: 200,
    text: async () => '',
    json: async () => ({}),
  } as unknown as Response
}

function installFetchMock(logicResponse: Response) {
  globalThis.fetch = vi.fn((input: string | URL | Request) => {
    const href = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : (input as Request).url
    if (href.includes('app-config.json')) return Promise.resolve(OK_APP_CONFIG)
    if (href.includes('logic.js')) return Promise.resolve(logicResponse)
    return Promise.resolve(makeOkEmpty())
  }) as unknown as typeof fetch
}

function makeCtx(): { ctx: WorkbenchContext; simulatorWc: MockWc } {
  const simulatorWc = stubs.makeWebContents()
  const ctx = {
    registry: { add: (_fn: AnyFn) => {} },
    simulatorApis: { has: (_name: string) => false, invoke: async () => ({}) },
    windows: { mainWindow: { webContents: simulatorWc } },
    workspace: { getSession: () => undefined },
    connections: createConnectionRegistry(),
  } as unknown as WorkbenchContext
  return { ctx, simulatorWc }
}

async function spawnSession(
  simulatorWc: MockWc,
  opts: { appId?: string } = {},
): Promise<{ result: SpawnResult; serviceWc: MockWc; serviceWindow: MockWin }> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  const req: SpawnRequest = {
    appId: opts.appId ?? APP_ID,
    pagePath: 'pages/index/index',
    resourceBaseUrl: 'http://127.0.0.1:1/',
  }
  const result = (await (handle as AnyFn)({ sender: simulatorWc }, req)) as SpawnResult
  const serviceWc = stubs.wcById.get(result.serviceWcId) as MockWc | undefined
  if (!serviceWc) throw new Error(`no mock webContents with id ${result.serviceWcId}`)
  const serviceWindow = stubs.createdWindows.find(w => w.webContents.id === result.serviceWcId)
  if (!serviceWindow) throw new Error('spawned service window not found')
  return { result, serviceWc, serviceWindow }
}

/** Subscribe a spy to the real ConsoleForwarder; returns the collected entries. */
function captureGuestConsoleErrors(ctx: WorkbenchContext): GuestConsoleEntry[] {
  const entries: GuestConsoleEntry[] = []
  const forwarder = ctx.guestConsole as ConsoleForwarder | undefined
  forwarder?.subscribe((e) => { entries.push(e) })
  return entries
}

/** Flush the microtask queue to let fire-and-forget boot promises settle. */
async function flush(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

/** Deliver a `renderHostReady` for a page via the RENDER_INVOKE ipcMain path. */
function dispatchRenderHostReady(bridgeId: string, renderWc: MockWc): void {
  const renderInvokeListeners = stubs.onListeners.get(C.RENDER_INVOKE)
  if (!renderInvokeListeners || renderInvokeListeners.size === 0) {
    throw new Error('RENDER_INVOKE listener not registered')
  }
  const payload: RenderInvokePayload = {
    bridgeId,
    msg: { type: 'renderHostReady', target: 'container', body: {} },
  }
  for (const fn of renderInvokeListeners) {
    ;(fn as AnyFn)({ sender: renderWc }, payload)
  }
}

/** Count TO_RENDER loadResource sends recorded on a render webContents. */
function renderLoadResourceCount(renderWc: MockWc): number {
  return renderWc.sentMessages.filter(
    m => m.channel === C.TO_RENDER
      && (m.payload as { msg: { type: string } }).msg?.type === 'loadResource',
  ).length
}

describe('bridge-router — logic bundle fetch fails (404)', () => {
  it('guards against loadResource send when logic.js returns 404: a reverted gate would forward loadResource, triggering the misleading "module app not found"', async () => {
    installFetchMock(makeFailLogic())
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { serviceWc, serviceWindow } = await spawnSession(simulatorWc)
    // Trigger bootServiceHost via the fresh-window did-finish-load path.
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    const loadResourceSent = serviceWc.sentMessages.some(
      m => m.channel === C.TO_SERVICE
        && (m.payload as { msg: { type: string } }).msg?.type === 'loadResource',
    )
    expect(
      loadResourceSent,
      'loadResource must NOT be sent to the service host when logic.js fetch fails',
    ).toBe(false)
  })

  it('emits one actionable guestConsole error referencing the logic bundle when logic.js returns 404', async () => {
    installFetchMock(makeFailLogic())
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const captured = captureGuestConsoleErrors(ctx)

    const { serviceWindow } = await spawnSession(simulatorWc)
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    const errorEntries = captured.filter(e => e.level === 'error' && e.source === 'service')
    expect(
      errorEntries.length,
      'exactly one error must be emitted via guestConsole when logic.js cannot be fetched',
    ).toBeGreaterThanOrEqual(1)
    const message = String((errorEntries[0]?.args ?? [])[0] ?? '')
    expect(
      message.toLowerCase().includes('logic') || message.toLowerCase().includes('bundle'),
      `error message "${message}" must reference the logic bundle`,
    ).toBe(true)
  })

  it('includes the logic.js URL in the error message so the developer knows which resource failed', async () => {
    installFetchMock(makeFailLogic())
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const captured = captureGuestConsoleErrors(ctx)

    const { serviceWindow } = await spawnSession(simulatorWc)
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    const errorEntries = captured.filter(e => e.level === 'error' && e.source === 'service')
    expect(errorEntries.length).toBeGreaterThanOrEqual(1)
    const message = String((errorEntries[0]?.args ?? [])[0] ?? '')
    // The URL contains the appId and root path so the developer can trace the missing resource.
    expect(
      message.includes('logic.js') || message.includes(APP_ID),
      `error message must include the logic.js URL or appId; got: "${message}"`,
    ).toBe(true)
  })
})

describe('bridge-router — logic bundle fetch fails with unknown appId', () => {
  it('emits a compile/manifest hint when appId is "unknown": guards the actionable diagnostic that tells the developer to check their build', async () => {
    installFetchMock(makeFailLogic())
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const captured = captureGuestConsoleErrors(ctx)

    const { serviceWindow } = await spawnSession(simulatorWc, { appId: 'unknown' })
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    const errorEntries = captured.filter(e => e.level === 'error' && e.source === 'service')
    expect(errorEntries.length).toBeGreaterThanOrEqual(1)
    const message = String((errorEntries[0]?.args ?? [])[0] ?? '')
    expect(
      message.includes('unknown'),
      `error message must mention "unknown" when appId is "unknown"; got: "${message}"`,
    ).toBe(true)
    const mentionsCompileOrManifest
      = message.toLowerCase().includes('compile')
      || message.toLowerCase().includes('manifest')
    expect(
      mentionsCompileOrManifest,
      `error message must hint at compile or manifest when appId is "unknown"; got: "${message}"`,
    ).toBe(true)
  })
})

describe('bridge-router — logic bundle fetch succeeds (200)', () => {
  it('sends loadResource to the service host when logic.js fetch and executeJavaScript succeed: a reverted gate would suppress this send', async () => {
    installFetchMock(makeOkLogic())
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { serviceWc, serviceWindow } = await spawnSession(simulatorWc)
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    const loadResourceSent = serviceWc.sentMessages.some(
      m => m.channel === C.TO_SERVICE
        && (m.payload as { msg: { type: string } }).msg?.type === 'loadResource',
    )
    expect(
      loadResourceSent,
      'loadResource MUST be sent to the service host when logic.js loads and executes successfully',
    ).toBe(true)
  })

  it('does not emit a guestConsole error when logic.js fetch and executeJavaScript succeed', async () => {
    installFetchMock(makeOkLogic())
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const captured = captureGuestConsoleErrors(ctx)

    const { serviceWindow } = await spawnSession(simulatorWc)
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    const errorEntries = captured.filter(e => e.level === 'error')
    expect(
      errorEntries.length,
      'guestConsole must not receive any error entries when logic.js succeeds',
    ).toBe(0)
  })
})

describe('bridge-router — renderHostReady is suppressed after failed logic injection', () => {
  it('does not forward loadResource to the render webContents when logicInjected is false: guards the render-side cryptic "module not found" suppression', async () => {
    installFetchMock(makeFailLogic())
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { result, serviceWindow } = await spawnSession(simulatorWc)
    // Boot must settle first so logicInjected is set to false.
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    const renderWc = stubs.makeWebContents()
    dispatchRenderHostReady(result.bridgeId, renderWc)
    await flush()

    const toRenderSent = renderWc.sentMessages.some(m => m.channel === C.TO_RENDER)
    expect(
      toRenderSent,
      'render webContents must NOT receive a TO_RENDER message when logicInjected is false',
    ).toBe(false)
  })
})

describe('bridge-router — renderHostReady racing in-flight logic injection', () => {
  it('holds render loadResource for a renderHostReady that beats a failing injection, then drops it: a fast-booting render must never get the cryptic "module <pagePath> not found"', async () => {
    installFetchMock(makeFailLogic())
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { result, serviceWindow } = await spawnSession(simulatorWc)
    const renderWc = stubs.makeWebContents()

    // renderHostReady arrives while injection is still in-flight (no
    // did-finish-load yet → logicInjected is null). The render loadResource must
    // be HELD, not sent.
    dispatchRenderHostReady(result.bridgeId, renderWc)
    await flush()
    expect(
      renderLoadResourceCount(renderWc),
      'render loadResource must be held while logic injection is in-flight',
    ).toBe(0)

    // Boot now runs and injection fails — the held render loadResource must be
    // dropped, never flushed to the render side.
    serviceWindow.webContents.emit('did-finish-load')
    await flush()
    expect(
      renderLoadResourceCount(renderWc),
      'a held render loadResource must be dropped when injection fails',
    ).toBe(0)
  })

  it('holds render loadResource for a renderHostReady that beats a successful injection, then flushes exactly one: holding must not drop a legitimate send', async () => {
    installFetchMock(makeOkLogic())
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { result, serviceWindow } = await spawnSession(simulatorWc)
    const renderWc = stubs.makeWebContents()

    // renderHostReady arrives before did-finish-load (logicInjected null) — held.
    dispatchRenderHostReady(result.bridgeId, renderWc)
    await flush()
    expect(
      renderLoadResourceCount(renderWc),
      'render loadResource must be held until injection settles',
    ).toBe(0)

    // Boot runs and injection succeeds — the held loadResource is flushed once.
    serviceWindow.webContents.emit('did-finish-load')
    await flush()
    expect(
      renderLoadResourceCount(renderWc),
      'a held render loadResource must be flushed exactly once when injection succeeds',
    ).toBe(1)
  })
})
