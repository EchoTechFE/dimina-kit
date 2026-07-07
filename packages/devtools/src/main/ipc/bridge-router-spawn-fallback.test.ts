/**
 * Guards handleSpawn's root-page resolution against the compiled manifest.
 *
 * ── The bug this guards against ─────────────────────────────────────────────
 * Without the check below, a spawn's requested `pagePath` would be trusted
 * verbatim: it becomes the root PageSession's pagePath, its
 * rootWindowConfig/isTab, and the page `bootServiceHost` sends `loadResource`
 * for — even when app-config.json's compiled `pages` list does not contain
 * it (a start page removed by a hot reload). That root-missing case would be
 * caught deep inside `bootServiceHost` (see `pageInManifest`/`rootMissing`),
 * which REFUSES to load anything: the simulator stays permanently blank with
 * no recovery.
 *
 * The fix moves the check to the request boundary: `handleSpawn` must decide
 * up front whether the requested pagePath is actually mountable, and if not,
 * resolve to a page that IS (`manifest.entryPagePath`, falling further back to
 * `manifest.pages[0]`) — so the root page that's actually spawned is always
 * valid, and the simulator shows a real page instead of a blank frame.
 * `SpawnResult` must report this resolution outcome (`resolvedPagePath`,
 * `pageFallbackApplied`) so callers (SimulatorMiniApp) can correct their own
 * bookkeeping instead of holding onto a pagePath the session was never
 * spawned with.
 *
 * A parallel change is landing a diagnostics bus (`ctx.diagnostics`,
 * `main/services/diagnostics`) reachable through `installBridgeRouter`
 * itself (it assigns `ctx.diagnostics = createDiagnosticsBus()`); this
 * suite subscribes to the REAL bus rather than stubbing it.
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

  return {
    onListeners, invokeHandlers, wcById,
    makeEmitter, makeWebContents, makeBrowserWindow, createWindowForSpawn,
    createdWindows,
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
import type { AppManifest, PageWindowConfig, SpawnRequest, SpawnResult, TabBarConfig } from '../../shared/bridge-channels.js'
import type { Diagnostic } from '../services/diagnostics/index.js'
import type { WorkbenchContext } from '../services/workbench-context.js'

type AnyFn = (...args: unknown[]) => unknown
type MockWc = ReturnType<typeof stubs.makeWebContents>

// The contract this suite pins: `SpawnResult` gains these two fields, and
// `AppManifest` gains `source`. Locally widened so the test compiles ahead of
// the (not yet landed) shared-type change; the assertions below are what
// actually pin the runtime behavior.
interface SpawnResultResolved extends SpawnResult {
  resolvedPagePath: string
  pageFallbackApplied: boolean
  manifest: AppManifest & { source: 'app-config' | 'fallback' }
}

const APP_ID = 'test-app'

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
  tabBar?: TabBarConfig
  window?: Partial<PageWindowConfig>
  modules?: Record<string, { window?: Partial<PageWindowConfig> }>
}

function makeAppConfigResponse(fixture: AppConfigFixture): Response {
  const body = {
    app: { entryPagePath: fixture.entryPagePath, pages: fixture.pages, tabBar: fixture.tabBar, window: fixture.window },
    modules: fixture.modules,
  }
  return {
    ok: true, status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function makeUnreachableAppConfigResponse(): Response {
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response
}

function makeOkEmpty(): Response {
  return { ok: true, status: 200, text: async () => '', json: async () => ({}) } as unknown as Response
}

/** Wires app-config.json to `fixture` (or a 404 when `fixture` is null); everything else 200s empty. */
function installFetchMock(fixture: AppConfigFixture | null): void {
  globalThis.fetch = vi.fn((input: string | URL | Request) => {
    const href = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : (input as Request).url
    if (href.includes('app-config.json')) {
      return Promise.resolve(fixture ? makeAppConfigResponse(fixture) : makeUnreachableAppConfigResponse())
    }
    if (href.includes('logic.js')) {
      return Promise.resolve({ ok: true, status: 200, text: async () => '/* logic bundle */', json: async () => ({}) } as unknown as Response)
    }
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
  pagePath: string,
): Promise<{ result: SpawnResultResolved; serviceWc: MockWc; serviceWindow: ReturnType<typeof stubs.makeBrowserWindow> }> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  const req: SpawnRequest = { appId: APP_ID, pagePath, resourceBaseUrl: 'http://127.0.0.1:1/' }
  const result = (await (handle as AnyFn)({ sender: simulatorWc }, req)) as SpawnResultResolved
  const serviceWc = stubs.wcById.get(result.serviceWcId) as MockWc | undefined
  if (!serviceWc) throw new Error(`no mock webContents with id ${result.serviceWcId}`)
  const serviceWindow = stubs.createdWindows.find(w => w.webContents.id === result.serviceWcId)
  if (!serviceWindow) throw new Error('spawned service window not found')
  return { result, serviceWc, serviceWindow }
}

/** Subscribes to the REAL diagnostics bus `installBridgeRouter` assigns to `ctx.diagnostics`. */
function captureDiagnostics(ctx: WorkbenchContext): Diagnostic[] {
  const out: Diagnostic[] = []
  ctx.diagnostics?.subscribe((d) => { out.push(d) }, { replay: false })
  return out
}

function serviceLoadResourcePagePaths(serviceWc: MockWc): string[] {
  return serviceWc.sentMessages
    .filter(m => m.channel === C.TO_SERVICE
      && (m.payload as { msg: { type: string } }).msg?.type === 'loadResource')
    .map(m => (m.payload as { msg: { body: { pagePath: string } } }).msg.body.pagePath)
}

async function flush(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

const ENTRY_PAGE = 'pages/index/index'
const OTHER_PAGE = 'pages/other/other'
const THIRD_PAGE = 'pages/third/third'
const BAD_PAGE = 'pages/removed/removed'

describe('handleSpawn — resolves the root pagePath against the compiled manifest', () => {
  it('keeps the requested pagePath as resolvedPagePath when it is present in manifest.pages', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { result } = await spawnSession(simulatorWc, OTHER_PAGE)

    expect(result.resolvedPagePath).toBe(OTHER_PAGE)
    expect(result.pageFallbackApplied).toBe(false)
  })

  it('falls back to manifest.entryPagePath when the requested pagePath is absent from manifest.pages', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { result } = await spawnSession(simulatorWc, BAD_PAGE)

    expect(result.resolvedPagePath).toBe(ENTRY_PAGE)
    expect(result.pageFallbackApplied).toBe(true)
  })

  it('falls back to pages[0] when entryPagePath itself is not a member of pages', async () => {
    // buildAppManifest lets entryPagePath diverge from `pages` (it defaults to
    // the request, not a pages[] member) — the fallback chain must not trust
    // entryPagePath blindly, only after confirming IT is actually mountable.
    installFetchMock({ entryPagePath: 'pages/ghost/ghost', pages: [OTHER_PAGE, THIRD_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { result } = await spawnSession(simulatorWc, BAD_PAGE)

    expect(result.resolvedPagePath).toBe(OTHER_PAGE)
    expect(result.pageFallbackApplied).toBe(true)
  })

  it('computes rootWindowConfig for the RESOLVED page, not the originally requested page', async () => {
    installFetchMock({
      entryPagePath: ENTRY_PAGE,
      pages: [ENTRY_PAGE, OTHER_PAGE],
      window: { navigationBarTitleText: 'App Default' },
      modules: { [ENTRY_PAGE]: { window: { navigationBarTitleText: 'Entry Title' } } },
    })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { result } = await spawnSession(simulatorWc, BAD_PAGE)

    expect(result.resolvedPagePath).toBe(ENTRY_PAGE)
    // BAD_PAGE has no per-page module entry, so a config computed off the
    // REQUEST would read the app-level default ('App Default'). A config
    // computed off the RESOLVED page must read ENTRY_PAGE's own override.
    expect(result.rootWindowConfig.navigationBarTitleText).toBe('Entry Title')
  })

  it('boots the service host with loadResource for the RESOLVED page, not the missing request', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { serviceWc, serviceWindow } = await spawnSession(simulatorWc, BAD_PAGE)
    serviceWindow.webContents.emit('did-finish-load')
    await flush()

    const pagePaths = serviceLoadResourcePagePaths(serviceWc)
    expect(pagePaths, `expected a loadResource for the resolved fallback "${ENTRY_PAGE}"; got: ${JSON.stringify(pagePaths)}`)
      .toContain(ENTRY_PAGE)
    expect(pagePaths, `must never loadResource for the missing request "${BAD_PAGE}"; got: ${JSON.stringify(pagePaths)}`)
      .not.toContain(BAD_PAGE)
  })

  it('reports a page-not-found diagnostic naming both the requested and the fallback page', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const diagnostics = captureDiagnostics(ctx)

    await spawnSession(simulatorWc, BAD_PAGE)

    const entry = diagnostics.find(d => d.code === 'page-not-found')
    expect(entry, `expected a page-not-found diagnostic; got: ${JSON.stringify(diagnostics)}`).toBeDefined()
    expect(entry!.severity).toBe('error')
    expect(entry!.message).toContain(BAD_PAGE)
    expect(entry!.message).toContain(ENTRY_PAGE)
  })

  it('reports no page-not-found diagnostic when the requested page is present in manifest.pages', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const diagnostics = captureDiagnostics(ctx)

    await spawnSession(simulatorWc, OTHER_PAGE)

    expect(diagnostics.find(d => d.code === 'page-not-found')).toBeUndefined()
  })

  it('applies no fallback and reports no diagnostic when app-config.json is unreachable', async () => {
    installFetchMock(null)
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const diagnostics = captureDiagnostics(ctx)

    const { result } = await spawnSession(simulatorWc, BAD_PAGE)

    // No app-config means no manifest to validate the request against — the
    // single-page fallback manifest trivially contains only the request
    // itself, so there is nothing to "fall back" from.
    expect(result.resolvedPagePath).toBe(BAD_PAGE)
    expect(result.pageFallbackApplied).toBe(false)
    expect(diagnostics.find(d => d.code === 'page-not-found')).toBeUndefined()
  })
})

describe('AppManifest.source — honest provenance of the compiled manifest', () => {
  it('marks source "app-config" when app-config.json loads successfully', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { result } = await spawnSession(simulatorWc, ENTRY_PAGE)

    expect(result.manifest.source).toBe('app-config')
  })

  it('marks source "fallback" when app-config.json is unreachable', async () => {
    installFetchMock(null)
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { result } = await spawnSession(simulatorWc, ENTRY_PAGE)

    expect(result.manifest.source).toBe('fallback')
  })
})
