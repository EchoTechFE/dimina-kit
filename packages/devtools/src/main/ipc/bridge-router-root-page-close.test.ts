/**
 * The launch page is a page like any other once navigation replaces it.
 * `reLaunch` / `redirectTo` / "back to home" drop it from the shell's stack and
 * ask main to tear it down, so a blanket refusal of `PAGE_CLOSE` on the root
 * page keeps a PageSession (and its render guest) in the router's ledger for
 * the rest of the session's life.
 *
 * The refusal is only right when the root page is the session's LAST page —
 * there `DISPOSE` owns the teardown, and closing the page alone would leave a
 * session with no pages at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  const invokeHandlers = new Map<string, AnyFn>()
  const eventHandlers = new Map<string, AnyFn>()

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

  let nextWcId = 9000

  function makeWebContents() {
    const em = makeEmitter()
    return {
      ...em,
      id: nextWcId++,
      isDestroyed() { return false },
      getURL: () => 'file:///service.html',
      getType: () => 'window',
      send: vi.fn(),
      executeJavaScript: vi.fn(() => Promise.resolve(undefined)),
      openDevTools: vi.fn(),
    }
  }

  function makeBrowserWindow() {
    const em = makeEmitter()
    return {
      ...em,
      webContents: makeWebContents(),
      isDestroyed() { return false },
      close: vi.fn(),
      loadURL: vi.fn(() => Promise.resolve()),
      loadFile: vi.fn(() => Promise.resolve()),
    }
  }

  function reset() {
    invokeHandlers.clear()
    eventHandlers.clear()
    nextWcId = 9000
  }

  return { invokeHandlers, eventHandlers, makeWebContents, makeBrowserWindow, reset }
})

vi.mock('electron', () => {
  type AnyFn = (...args: unknown[]) => unknown

  const ipcMain = {
    on: vi.fn((channel: string, fn: AnyFn) => { stubs.eventHandlers.set(channel, fn) }),
    removeListener: vi.fn((channel: string) => { stubs.eventHandlers.delete(channel) }),
    handle: vi.fn((channel: string, fn: AnyFn) => { stubs.invokeHandlers.set(channel, fn) }),
    removeHandler: vi.fn((channel: string) => { stubs.invokeHandlers.delete(channel) }),
  }

  return {
    ipcMain,
    app: { isPackaged: true, getLocale: () => 'en-US', getPath: vi.fn(() => '/tmp/dimina-runtime-test') },
    BrowserWindow: class {},
    WebContentsView: class { webContents = {}; setBounds = vi.fn(); setBackgroundColor = vi.fn() },
    protocol: { handle: vi.fn(), unhandle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
    session: {
      fromPartition: vi.fn(() => ({
        webRequest: { onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() },
        registerPreloadScript: vi.fn(),
        protocol: { handle: vi.fn(), unhandle: vi.fn() },
      })),
      defaultSession: { protocol: { handle: vi.fn(), unhandle: vi.fn() } },
    },
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

import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type { PageOpenResult, SpawnRequest, SpawnResult } from '../../shared/bridge-channels.js'
import type { BridgeRouterHandle } from './bridge-router.js'
import type { WorkbenchContext } from '../services/workbench-context.js'

type AnyFn = (...args: unknown[]) => unknown
type MockWc = ReturnType<typeof stubs.makeWebContents>

const APP_ID = 'test-app'
const ROOT_PAGE = 'pages/index/index'
const SECOND_PAGE = 'pages/second/second'

let installBridgeRouter: typeof import('./bridge-router.js').installBridgeRouter
let originalFetch: typeof globalThis.fetch

beforeEach(async () => {
  vi.resetModules()
  stubs.reset()
  originalFetch = globalThis.fetch
  installFetchMock()
  ;({ installBridgeRouter } = await import('./bridge-router.js'))
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** Serves a compiled app-config listing both pages. */
function installFetchMock(): void {
  globalThis.fetch = vi.fn((input: string | URL | Request) => {
    const href = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : (input as Request).url
    if (href.includes('app-config.json')) {
      const body = { app: { entryPagePath: ROOT_PAGE, pages: [ROOT_PAGE, SECOND_PAGE] } }
      return Promise.resolve({
        ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
      } as unknown as Response)
    }
    return Promise.resolve({ ok: true, status: 200, text: async () => '', json: async () => ({}) } as unknown as Response)
  }) as unknown as typeof fetch
}

interface Harness {
  ctx: WorkbenchContext
  bridge: BridgeRouterHandle
  simulatorWc: MockWc
}

function makeHarness(): Harness {
  const simulatorWc = stubs.makeWebContents()
  const ctx = {
    registry: { add: (_fn: AnyFn) => {} },
    simulatorApis: { has: (_name: string) => false, invoke: async () => ({}), list: () => [] },
    windows: { mainWindow: { webContents: simulatorWc } },
    workspace: { getSession: () => undefined, getProjectPath: () => '/tmp/dimina-project', isClosing: () => false },
    connections: createConnectionRegistry(),
  } as unknown as WorkbenchContext
  installBridgeRouter(ctx)
  const bridge = (ctx as unknown as { bridge: BridgeRouterHandle }).bridge
  return { ctx, bridge, simulatorWc }
}

async function spawnSession(simulatorWc: MockWc, pagePath: string): Promise<SpawnResult> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  const req: SpawnRequest = { appId: APP_ID, pagePath, resourceBaseUrl: 'http://127.0.0.1:1/' }
  return (await (handle as AnyFn)({ sender: simulatorWc }, req)) as SpawnResult
}

async function openPage(
  simulatorWc: MockWc,
  appSessionId: string,
  pagePath: string,
): Promise<PageOpenResult> {
  const handle = stubs.invokeHandlers.get(C.PAGE_OPEN)
  if (!handle) throw new Error('PAGE_OPEN handler not registered')
  return (await (handle as AnyFn)({ sender: simulatorWc }, { appSessionId, pagePath })) as PageOpenResult
}

function closePage(simulatorWc: MockWc, bridgeId: string): void {
  const handle = stubs.eventHandlers.get(C.PAGE_CLOSE)
  if (!handle) throw new Error('PAGE_CLOSE handler not registered')
  ;(handle as AnyFn)({ sender: simulatorWc }, { bridgeId })
}

function pageCount(bridge: BridgeRouterHandle): number {
  return bridge.census!().pageSessions
}

/** Whether the router still tracks a page under this bridgeId. */
function isTracked(bridge: BridgeRouterHandle, bridgeId: string): boolean {
  return bridge.getServiceWcForBridge(bridgeId) !== null
}

describe('PAGE_CLOSE — the launch page after navigation replaced it', () => {
  it('tears down the retired launch page while the rest of the session lives on', async () => {
    const { bridge, simulatorWc } = makeHarness()
    const spawned = await spawnSession(simulatorWc, ROOT_PAGE)
    const second = await openPage(simulatorWc, spawned.appSessionId, SECOND_PAGE)
    expect(pageCount(bridge)).toBe(2)

    closePage(simulatorWc, spawned.bridgeId)

    expect(isTracked(bridge, spawned.bridgeId)).toBe(false)
    expect(isTracked(bridge, second.bridgeId)).toBe(true)
    expect(pageCount(bridge)).toBe(1)
    expect(bridge.census!().appSessions).toBe(1)
  })

  it('keeps the launch page when it is the session\'s only page', async () => {
    const { bridge, simulatorWc } = makeHarness()
    const spawned = await spawnSession(simulatorWc, ROOT_PAGE)
    expect(pageCount(bridge)).toBe(1)

    closePage(simulatorWc, spawned.bridgeId)

    expect(isTracked(bridge, spawned.bridgeId)).toBe(true)
    expect(pageCount(bridge)).toBe(1)
    expect(bridge.census!().appSessions).toBe(1)
  })
})
