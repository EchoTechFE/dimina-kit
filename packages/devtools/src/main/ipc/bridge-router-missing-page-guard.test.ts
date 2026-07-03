/**
 * Guards bootServiceHost's root-page existence check: the root page's
 * pagePath must be validated against the compiled app manifest (ap.manifest.pages)
 * before a loadResource is sent for it, on EITHER side. A pagePath a developer
 * removed after a hot reload is no longer in the manifest, so forwarding
 * loadResource for it would make a runtime `modRequire` a module that was
 * never registered and throw the cryptic `module <pagePath> not found` —
 * service-side aborting the launch, render-side leaving the simulator
 * permanently blank. The gate must skip BOTH the service loadResource and the
 * render loadResource for the missing root page, and emit one diagnostic
 * instead. Picking a fallback page belongs at the renderer reload source, not
 * here, so main and render never disagree about which page is live.
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

  let nextWcId = 6000
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
    nextWcId = 6000
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
import type { MessageEnvelope, SpawnRequest, SpawnResult } from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { ConsoleForwarder, GuestConsoleEntry } from '../services/console-forward/index.js'

type AnyFn = (...args: unknown[]) => unknown
type MockWc = ReturnType<typeof stubs.makeWebContents>
type MockWin = ReturnType<typeof stubs.makeBrowserWindow>

const APP_ID = 'test-app'

let installBridgeRouter: typeof import('./bridge-router.js').installBridgeRouter

const PRIOR_POOL_ENV = process.env.DIMINA_PREWARM_POOL_SIZE
const PRIOR_DISABLE_ENV = process.env.DIMINA_PREWARM_DISABLE

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
  if (PRIOR_POOL_ENV === undefined) delete process.env.DIMINA_PREWARM_POOL_SIZE
  else process.env.DIMINA_PREWARM_POOL_SIZE = PRIOR_POOL_ENV
  if (PRIOR_DISABLE_ENV === undefined) delete process.env.DIMINA_PREWARM_DISABLE
  else process.env.DIMINA_PREWARM_DISABLE = PRIOR_DISABLE_ENV
})

function makeOkLogic(): Response {
  return {
    ok: true, status: 200,
    text: async () => '/* logic bundle */',
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

/** app-config.json content: `app.pages` is the compiled manifest's page list. */
interface AppConfigFixture {
  entryPagePath?: string
  pages?: string[]
}

function makeAppConfigResponse(fixture: AppConfigFixture): Response {
  const body = { app: { entryPagePath: fixture.entryPagePath, pages: fixture.pages } }
  return {
    ok: true, status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

/** Wires app-config.json + logic.js responses; everything else 200s empty. */
function installFetchMock(appConfig: AppConfigFixture): void {
  globalThis.fetch = vi.fn((input: string | URL | Request) => {
    const href = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : (input as Request).url
    if (href.includes('app-config.json')) return Promise.resolve(makeAppConfigResponse(appConfig))
    if (href.includes('logic.js')) return Promise.resolve(makeOkLogic())
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
  opts: { pagePath: string },
): Promise<{ result: SpawnResult; serviceWc: MockWc; serviceWindow: MockWin }> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  const req: SpawnRequest = {
    appId: APP_ID,
    pagePath: opts.pagePath,
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

/** Every `loadResource` sent to the service host, with the pagePath it carries. */
function serviceLoadResourcePagePaths(serviceWc: MockWc): string[] {
  return serviceWc.sentMessages
    .filter(m => m.channel === C.TO_SERVICE
      && (m.payload as { msg: { type: string } }).msg?.type === 'loadResource')
    .map(m => (m.payload as { msg: { body: { pagePath: string } } }).msg.body.pagePath)
}

/** Every `loadResource` sent to a render guest, with the pagePath it carries. */
function renderLoadResourcePagePaths(renderWc: MockWc): string[] {
  return renderWc.sentMessages
    .filter(m => m.channel === C.TO_RENDER
      && (m.payload as { msg: { type: string } }).msg?.type === 'loadResource')
    .map(m => (m.payload as { msg: { body: { pagePath: string } } }).msg.body.pagePath)
}

/**
 * Simulates the render guest's `renderHostReady` firing on its own
 * DOMContentLoaded, routed through the real RENDER_INVOKE handler exactly
 * like production IPC does (this is what binds `renderWc` onto the page via
 * `ensureRenderBound`, so a later `sendRenderLoadResource` targets it).
 */
function emitRenderHostReady(renderWc: MockWc, bridgeId: string): void {
  const listeners = stubs.onListeners.get(C.RENDER_INVOKE)
  if (!listeners) throw new Error('RENDER_INVOKE handler not registered')
  const msg: MessageEnvelope = { type: 'renderHostReady', target: 'render', body: {} }
  for (const fn of [...listeners]) (fn as AnyFn)({ sender: renderWc }, { bridgeId, msg })
}

const BAD_PAGE = 'pages/removed/removed'
const ENTRY_PAGE = 'pages/index/index'
const OTHER_PAGE = 'pages/other/other'

describe('bridge-router — root pagePath missing from the compiled manifest', () => {
  it('does not send service loadResource for a root pagePath absent from ap.manifest.pages', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { serviceWc, serviceWindow } = await spawnSession(simulatorWc, { pagePath: BAD_PAGE })
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    const pagePaths = serviceLoadResourcePagePaths(serviceWc)
    expect(
      pagePaths.includes(BAD_PAGE),
      `loadResource must NOT be sent for "${BAD_PAGE}" (not in manifest.pages); sent pagePaths: ${JSON.stringify(pagePaths)}`,
    ).toBe(false)
  })

  it('emits a guestConsole error in the "Page[...] not found" wechat-devtools style for the missing root pagePath', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const captured = captureGuestConsoleErrors(ctx)

    const { serviceWindow } = await spawnSession(simulatorWc, { pagePath: BAD_PAGE })
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    const errorEntries = captured.filter(e => e.level === 'error' && e.source === 'service')
    expect(
      errorEntries.some(e => String((e.args ?? [])[0] ?? '').includes(`Page[${BAD_PAGE}] not found`)),
      `expected a guestConsole error containing "Page[${BAD_PAGE}] not found"; got: ${JSON.stringify(errorEntries.map(e => e.args))}`,
    ).toBe(true)
  })

  it('does not flush the pending render loadResource for a root pagePath absent from ap.manifest.pages', async () => {
    // Guards bug-2 of the missing-page fix: bootServiceHost used to gate only
    // the SERVICE-side loadResource and still flush the RENDER-side one for
    // the same missing root page once injection settled, so the render guest
    // `modRequire`d the same never-registered module and threw. Reproduce the
    // exact race that feeds that flush path: the render guest's
    // `renderHostReady` routinely beats the async logic.js fetch+inject, so it
    // arrives while `ap.logicInjected` is still `null` — routeFromRender then
    // parks it as `renderLoadPending` for bootServiceHost to flush later. Fire
    // `renderHostReady` synchronously right after `did-finish-load`, before
    // any awaited mock (fetch/text/executeJavaScript) gets a microtask turn,
    // so it lands inside that in-flight window every time.
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const renderWc = stubs.makeWebContents()

    const { result, serviceWindow } = await spawnSession(simulatorWc, { pagePath: BAD_PAGE })
    serviceWindow.webContents.emit('did-finish-load')
    emitRenderHostReady(renderWc, result.bridgeId)
    await flush()

    const pagePaths = renderLoadResourcePagePaths(renderWc)
    expect(
      pagePaths.includes(BAD_PAGE),
      `render loadResource must NOT be sent for "${BAD_PAGE}" (not in manifest.pages); sent pagePaths: ${JSON.stringify(pagePaths)}`,
    ).toBe(false)
  })

  it('does not send a render loadResource for a missing root page on a late renderHostReady (after logic injection settled)', async () => {
    // Guards the other half of the missing-page fix: routeFromRender's
    // renderHostReady handler sends the render loadResource DIRECTLY (not via
    // bootServiceHost's flush loop) whenever `ap.logicInjected` has already
    // settled to `true` — i.e. the render guest reports readiness AFTER
    // bootServiceHost fully resolved, not in the race window the sibling test
    // above exercises. The gate used to live only around bootServiceHost's
    // flush loop, so this direct-send call site forwarded the bad page's
    // render loadResource unguarded. Let did-finish-load's bootServiceHost run
    // to completion (flush) BEFORE renderHostReady fires, so `logicInjected`
    // is `true` and `routeFromRender` takes the direct-send branch, not the
    // `renderLoadPending` park-and-flush branch the earlier test covers.
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const renderWc = stubs.makeWebContents()

    const { result, serviceWindow } = await spawnSession(simulatorWc, { pagePath: BAD_PAGE })
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    emitRenderHostReady(renderWc, result.bridgeId)
    await flush()

    const pagePaths = renderLoadResourcePagePaths(renderWc)
    expect(
      pagePaths.includes(BAD_PAGE),
      `render loadResource must NOT be sent for "${BAD_PAGE}" (not in manifest.pages) on a late renderHostReady; sent pagePaths: ${JSON.stringify(pagePaths)}`,
    ).toBe(false)
  })
})

describe('bridge-router — root pagePath present in the compiled manifest (no regression)', () => {
  it('sends service loadResource for the root pagePath when it is present in ap.manifest.pages', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { serviceWc, serviceWindow } = await spawnSession(simulatorWc, { pagePath: OTHER_PAGE })
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    const pagePaths = serviceLoadResourcePagePaths(serviceWc)
    expect(
      pagePaths.includes(OTHER_PAGE),
      `loadResource MUST be sent for "${OTHER_PAGE}" (present in manifest.pages); sent pagePaths: ${JSON.stringify(pagePaths)}`,
    ).toBe(true)
  })

  it('emits no guestConsole error when the root pagePath is present in the manifest', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const captured = captureGuestConsoleErrors(ctx)

    const { serviceWindow } = await spawnSession(simulatorWc, { pagePath: OTHER_PAGE })
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    const errorEntries = captured.filter(e => e.level === 'error')
    expect(
      errorEntries.length,
      'guestConsole must not receive any error entries when the root pagePath is present in the manifest',
    ).toBe(0)
  })

  it('still sends a render loadResource for a valid root page on a late renderHostReady (after logic injection settled)', async () => {
    // `sendRenderLoadResource`'s `pageInManifest` gate is a single choke point
    // shared by BOTH the boot flush loop and this direct-send late-arrival
    // branch (guarded by the two "does not send" tests above for a BAD page).
    // A gate that is too broad — e.g. one that (mis)fires for every page
    // instead of only the missing one — would silently swallow this valid
    // page's render loadResource too, leaving the simulator blank without any
    // diagnostic. Reproduce the exact same late-arrival timing as the sibling
    // missing-page test (let bootServiceHost fully settle via flush() BEFORE
    // renderHostReady fires, so `routeFromRender` takes the direct-send branch
    // here, not the renderLoadPending park-and-flush branch), but with a page
    // that IS present in the manifest.
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const renderWc = stubs.makeWebContents()

    const { result, serviceWindow } = await spawnSession(simulatorWc, { pagePath: OTHER_PAGE })
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    emitRenderHostReady(renderWc, result.bridgeId)
    await flush()

    const pagePaths = renderLoadResourcePagePaths(renderWc)
    expect(
      pagePaths.includes(OTHER_PAGE),
      `render loadResource MUST be sent for "${OTHER_PAGE}" (present in manifest.pages) on a late renderHostReady; sent pagePaths: ${JSON.stringify(pagePaths)}`,
    ).toBe(true)
  })
})
