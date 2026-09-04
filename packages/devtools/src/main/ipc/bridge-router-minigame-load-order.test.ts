/**
 * A mini-game's service `loadResource` synchronously `modRequire`s game.js,
 * whose top-level `wx.createCanvas()` fires a `createGameCanvas` message at
 * render immediately. If service's `loadResource` goes out before the render
 * guest has reported `renderHostReady`, that message has no listener and is
 * dropped — the canvas never exists and every later draw flush warns `canvas
 * node <id> not found` against a permanently blank screen.
 *
 * `bootServiceHost` holds a game session's root service `loadResource` until
 * the root render guest is listening (`AppSession.serviceLoadDeferred`), and
 * `releaseDeferredServiceLoad` issues it the moment `renderHostReady` arrives
 * — after the render `loadResource` has gone out, matching upstream's own
 * `Bridge.start` ordering (webview before jscore). A mini-program session
 * (`runtimeType !== 'game'`) has no such race (its page instance mounts from
 * `resourceLoaded`, not a synchronous top-level script) and must keep getting
 * its service `loadResource` at boot, unconditionally.
 *
 * Harness mirrors bridge-router-logic-bundle-fail-loud.test.ts (fresh-window
 * did-finish-load boot trigger, RENDER_INVOKE-dispatched renderHostReady,
 * sentMessages filtering).
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

// Pooling is OFF in this suite — every spawn takes the fresh-window path,
// whose only did-finish-load is the service.html boot load bootServiceHost
// listens for.
vi.mock('@dimina-kit/electron-runtime/main/service-host-window', () => ({
  serviceHostSpec: () => ({}),
  serviceHostPreloadPath: '/tmp/preload.cjs',
  SERVICE_HOST_PARTITION: 'persist:simulator',
  buildServiceHostSpawnUrl: () => 'file:///service.html',
  navigateServiceHost: vi.fn(() => Promise.resolve()),
  createServiceHostWindow: vi.fn(() => stubs.createWindowForSpawn()),
  constructServiceHostWindow: vi.fn(() => stubs.createWindowForSpawn()),
}))

import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type { RenderInvokePayload, SpawnRequest, SpawnResult } from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'

type AnyFn = (...args: unknown[]) => unknown
type MockWc = ReturnType<typeof stubs.makeWebContents>
type MockWin = ReturnType<typeof stubs.makeBrowserWindow>

const APP_ID = 'test-app'
const GAME_ENTRY = 'game'
const MP_ENTRY = 'pages/index/index'

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
})

function makeOkLogic(): Response {
  return { ok: true, status: 200, text: async () => '/* logic */', json: async () => ({}) } as unknown as Response
}

function makeOkEmpty(): Response {
  return { ok: true, status: 200, text: async () => '', json: async () => ({}) } as unknown as Response
}

/** Wires app-config.json to `fixture` and a successful logic.js. */
function installFetchMock(fixture: { entryPagePath: string; pages: string[]; runtimeType?: string }): void {
  const body = { app: { entryPagePath: fixture.entryPagePath, pages: fixture.pages, runtimeType: fixture.runtimeType } }
  globalThis.fetch = vi.fn((input: string | URL | Request) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (href.includes('app-config.json')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response)
    }
    if (href.includes('logic.js')) return Promise.resolve(makeOkLogic())
    return Promise.resolve(makeOkEmpty())
  }) as unknown as typeof fetch
}

function makeCtx(): { ctx: WorkbenchContext; simulatorWc: MockWc } {
  const simulatorWc = stubs.makeWebContents()
  const ctx = {
    registry: { add: (_fn: AnyFn) => {} },
    simulatorApis: { has: (_name: string) => false, invoke: async () => ({}), list: () => [] },
    windows: { mainWindow: { webContents: simulatorWc, isDestroyed: () => false } },
    workspace: { getSession: () => undefined },
    connections: createConnectionRegistry(),
  } as unknown as WorkbenchContext
  return { ctx, simulatorWc }
}

async function spawnSession(
  simulatorWc: MockWc,
  pagePath: string,
): Promise<{ result: SpawnResult; serviceWc: MockWc; serviceWindow: MockWin }> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  const req: SpawnRequest = { appId: APP_ID, pagePath, resourceBaseUrl: 'http://127.0.0.1:1/' }
  const result = (await (handle as AnyFn)({ sender: simulatorWc }, req)) as SpawnResult
  const serviceWc = stubs.wcById.get(result.serviceWcId) as MockWc | undefined
  if (!serviceWc) throw new Error(`no mock webContents with id ${result.serviceWcId}`)
  const serviceWindow = stubs.createdWindows.find(w => w.webContents.id === result.serviceWcId)
  if (!serviceWindow) throw new Error('spawned service window not found')
  return { result, serviceWc, serviceWindow }
}

/** Deliver a `renderHostReady` for a page via the RENDER_INVOKE ipcMain path
 *  (also binds `renderWc` as that page's render webContents). */
function dispatchRenderHostReady(bridgeId: string, renderWc: MockWc): void {
  const renderInvokeListeners = stubs.onListeners.get(C.RENDER_INVOKE)
  if (!renderInvokeListeners || renderInvokeListeners.size === 0) {
    throw new Error('RENDER_INVOKE listener not registered')
  }
  const payload: RenderInvokePayload = {
    bridgeId,
    msg: { type: 'renderHostReady', target: 'container', body: {} },
  }
  for (const fn of renderInvokeListeners) (fn as AnyFn)({ sender: renderWc }, payload)
}

async function flush(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

function serviceLoadResourceSent(serviceWc: MockWc): boolean {
  return serviceWc.sentMessages.some(
    m => m.channel === C.TO_SERVICE && (m.payload as { msg: { type: string } }).msg?.type === 'loadResource',
  )
}

function renderLoadResourceCount(renderWc: MockWc): number {
  return renderWc.sentMessages.filter(
    m => m.channel === C.TO_RENDER && (m.payload as { msg: { type: string } }).msg?.type === 'loadResource',
  ).length
}

/** Tags every `wc.send` call onto `order`, preserving the mock's own
 *  bookkeeping (`sentMessages`) so both can be asserted from one dispatch. */
function tapSendOrder(wc: MockWc, tag: string, order: string[]): void {
  const original = wc.send
  wc.send = vi.fn((channel: string, payload: unknown) => {
    order.push(tag)
    return (original as AnyFn)(channel, payload)
  }) as typeof wc.send
}

describe('bridge-router — mini-game service loadResource waits for renderHostReady', () => {
  it('does not send service loadResource once boot completes, before the render guest reports renderHostReady', async () => {
    installFetchMock({ entryPagePath: GAME_ENTRY, pages: [GAME_ENTRY], runtimeType: 'game' })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { serviceWc, serviceWindow } = await spawnSession(simulatorWc, GAME_ENTRY)
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    expect(
      serviceLoadResourceSent(serviceWc),
      'a game session must not send service loadResource before the root render guest is listening',
    ).toBe(false)
  })

  it('sends render loadResource before service loadResource once renderHostReady arrives', async () => {
    installFetchMock({ entryPagePath: GAME_ENTRY, pages: [GAME_ENTRY], runtimeType: 'game' })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { result, serviceWc, serviceWindow } = await spawnSession(simulatorWc, GAME_ENTRY)
    serviceWindow.webContents.emit('did-finish-load')
    await flush()
    expect(serviceLoadResourceSent(serviceWc), 'precondition: still held before renderHostReady').toBe(false)

    const renderWc = stubs.makeWebContents()
    const order: string[] = []
    tapSendOrder(renderWc, 'render', order)
    tapSendOrder(serviceWc, 'service', order)

    dispatchRenderHostReady(result.bridgeId, renderWc)
    await flush()

    expect(renderLoadResourceCount(renderWc), 'render loadResource must go out exactly once').toBe(1)
    expect(
      serviceLoadResourceSent(serviceWc),
      'the deferred service loadResource must be released once the root render guest is listening',
    ).toBe(true)
    expect(
      order.indexOf('render'),
      `render loadResource must be sent before service loadResource; send order: ${JSON.stringify(order)}`,
    ).toBeLessThan(order.indexOf('service'))
  })

  it('a mini-program session (non-game) still gets service loadResource at boot, unaffected by render readiness', async () => {
    installFetchMock({ entryPagePath: MP_ENTRY, pages: [MP_ENTRY] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { serviceWc, serviceWindow } = await spawnSession(simulatorWc, MP_ENTRY)
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    expect(
      serviceLoadResourceSent(serviceWc),
      'a mini-program session must send service loadResource at boot, with no render guest ever reporting renderHostReady',
    ).toBe(true)
  })
})
