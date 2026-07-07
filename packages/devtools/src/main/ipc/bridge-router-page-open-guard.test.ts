/**
 * Guards `handlePageOpen`'s defense gate against the compiled manifest.
 *
 * ── The bug this guards against ─────────────────────────────────────────────
 * Without the check below, `handlePageOpen` (PAGE_OPEN) would build and
 * register a PageSession for ANY `pagePath` the caller supplies, with no
 * manifest check — unlike the spawn-time root page (which the sibling fix
 * resolves against `ap.manifest.pages`), a non-root `PAGE_OPEN` for a page
 * the developer deleted (hot-reloaded to) would still create a zombie
 * PageSession that main will later try to load resources for, and that
 * never has a valid render target.
 *
 * The fix rejects the PAGE_OPEN call outright (before any PageSession is
 * registered) when `opts.pagePath` is absent from `ap.manifest.pages` AND the
 * manifest is a real compiled one (`source === 'app-config'`); a `'fallback'`
 * (unreachable app-config, single-page) manifest can't validate membership,
 * so it must keep behaving exactly as today (permissive).
 *
 * The router's resource census (`globalThis.__diminaResourceCensus`, gated
 * on `NODE_ENV === 'test'`, see `bridge-router-census.test.ts`) is the
 * observable proof that no zombie PageSession survives a rejected call:
 * `pageSessions` must stay at 1 (just the root) after a rejected PAGE_OPEN.
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

  let nextWcId = 9000
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
      listenerCount(event: string) { return em.listeners[event]?.size ?? 0 },
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
    nextWcId = 9000
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
import type { PageOpenRequest, PageOpenResult, SpawnRequest, SpawnResult } from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { BridgeResourceCensus } from './bridge-router.js'

type AnyFn = (...args: unknown[]) => unknown
type MockWc = ReturnType<typeof stubs.makeWebContents>

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

interface AppConfigFixture {
  entryPagePath?: string
  pages?: string[]
}

function makeAppConfigResponse(fixture: AppConfigFixture): Response {
  const body = { app: { entryPagePath: fixture.entryPagePath, pages: fixture.pages } }
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
}

function makeUnreachableAppConfigResponse(): Response {
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response
}

function installFetchMock(fixture: AppConfigFixture | null): void {
  globalThis.fetch = vi.fn((input: string | URL | Request) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (href.includes('app-config.json')) {
      return Promise.resolve(fixture ? makeAppConfigResponse(fixture) : makeUnreachableAppConfigResponse())
    }
    return Promise.resolve({ ok: true, status: 200, text: async () => '', json: async () => ({}) } as unknown as Response)
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

async function spawnSession(simulatorWc: MockWc, pagePath: string): Promise<SpawnResult> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  const req: SpawnRequest = { appId: 'page-open-guard-app', pagePath, resourceBaseUrl: 'http://127.0.0.1:1/' }
  return (await (handle as AnyFn)({ sender: simulatorWc }, req)) as SpawnResult
}

async function pageOpen(simulatorWc: MockWc, req: PageOpenRequest): Promise<PageOpenResult> {
  const handle = stubs.invokeHandlers.get(C.PAGE_OPEN)
  if (!handle) throw new Error('PAGE_OPEN handler not registered')
  return (await (handle as AnyFn)({ sender: simulatorWc }, req)) as PageOpenResult
}

function readCensus(): BridgeResourceCensus {
  const probe = (globalThis as Record<string, unknown>).__diminaResourceCensus
  if (typeof probe !== 'function') throw new Error('__diminaResourceCensus not registered')
  return (probe as () => BridgeResourceCensus)()
}

const ENTRY_PAGE = 'pages/index/index'
const OTHER_PAGE = 'pages/other/other'
const BAD_PAGE = 'pages/removed/removed'

describe('handlePageOpen — rejects a pagePath absent from the compiled manifest', () => {
  it('rejects with a page-not-found message naming the pagePath, for a real (app-config) manifest', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const spawnResult = await spawnSession(simulatorWc, ENTRY_PAGE)

    await expect(
      pageOpen(simulatorWc, { appSessionId: spawnResult.appSessionId, pagePath: BAD_PAGE }),
    ).rejects.toThrow(new RegExp(`page-not-found.*${BAD_PAGE}|${BAD_PAGE}.*page-not-found`))
  })

  it('never registers a PageSession for the rejected pagePath (no zombie session in the census)', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const spawnResult = await spawnSession(simulatorWc, ENTRY_PAGE)

    expect(readCensus().pageSessions).toBe(1) // just the root page

    await pageOpen(simulatorWc, { appSessionId: spawnResult.appSessionId, pagePath: BAD_PAGE }).catch(() => {})

    expect(readCensus().pageSessions, 'a rejected PAGE_OPEN must not leave a zombie PageSession').toBe(1)
  })

  it('still opens a page present in manifest.pages (no regression)', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const spawnResult = await spawnSession(simulatorWc, ENTRY_PAGE)

    const result = await pageOpen(simulatorWc, { appSessionId: spawnResult.appSessionId, pagePath: OTHER_PAGE })

    expect(result.pagePath).toBe(OTHER_PAGE)
    expect(readCensus().pageSessions).toBe(2)
  })
})

describe('handlePageOpen — the gate is skipped for a "fallback" (unreachable app-config) manifest', () => {
  it('still opens an arbitrary pagePath when app-config.json was unreachable', async () => {
    installFetchMock(null)
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const spawnResult = await spawnSession(simulatorWc, ENTRY_PAGE)

    const result = await pageOpen(simulatorWc, { appSessionId: spawnResult.appSessionId, pagePath: BAD_PAGE })

    expect(result.pagePath).toBe(BAD_PAGE)
    expect(readCensus().pageSessions).toBe(2)
  })

  it('a page the fallback front gates admitted actually receives its render loadResource (back gate agrees)', async () => {
    // A 'fallback' manifest holds only the spawn request, so every membership
    // gate must let arbitrary pages through CONSISTENTLY: if PAGE_OPEN admits a
    // page but the render-load back gate still checks `manifest.pages`, the
    // admitted page silently never loads (blank guest, no callback, no error).
    installFetchMock(null)
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const spawnResult = await spawnSession(simulatorWc, ENTRY_PAGE)

    // Boot the service host so logic injection settles (logicInjected=true) and
    // the late renderHostReady below takes the direct render-load send path.
    const serviceWc = stubs.wcById.get(spawnResult.serviceWcId)
    if (!serviceWc) throw new Error('service wc not captured by the electron stub')
    serviceWc.emit('did-finish-load')
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (let i = 0; i < 10; i++) await Promise.resolve()

    const opened = await pageOpen(simulatorWc, { appSessionId: spawnResult.appSessionId, pagePath: BAD_PAGE })

    const renderWc = stubs.makeWebContents()
    for (const fn of stubs.onListeners.get(C.RENDER_INVOKE) ?? []) {
      ;(fn as AnyFn)(
        { sender: renderWc },
        { bridgeId: opened.bridgeId, msg: { type: 'renderHostReady', target: 'container', body: { bridgeId: opened.bridgeId } } },
      )
    }

    const loadedPagePaths = renderWc.sentMessages
      .filter((m) => (m.payload as { msg?: { type?: string } })?.msg?.type === 'loadResource')
      .map((m) => (m.payload as { msg: { body: { pagePath: string } } }).msg.body.pagePath)
    expect(
      loadedPagePaths,
      'the render-load back gate must not drop a page the fallback front gates admitted',
    ).toContain(BAD_PAGE)
  })
})
