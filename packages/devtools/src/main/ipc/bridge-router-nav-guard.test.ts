/**
 * Guards the main-side navigation gate `handleNavActionApi`/`handleTabActionApi`
 * must apply BEFORE forwarding `navigateTo`/`redirectTo`/`reLaunch`/`switchTab`
 * to the simulator window.
 *
 * ── The bug being pinned (TDD red) ──────────────────────────────────────────
 * Today `handleSimulatorApi` forwards any NAV_ACTION_NAMES/TAB_ACTION_NAMES
 * call straight to the simulator window with no manifest check at all. A
 * `wx.navigateTo({ url: '/pages/removed/removed' })` to a page the developer
 * deleted (and the compiler no longer emits) is silently handed to the
 * DeviceShell, which will try to open a page the render/service runtimes were
 * never given a module for — deep, hard-to-diagnose failure, and the
 * service-side `fail` callback may never fire at all (device-shell's own
 * `openPage` awaits a bundle that can never load).
 *
 * The fix gates at the router (the request boundary), symmetric with the
 * spawn-time root-page fallback: a target absent from `ap.manifest.pages` is
 * rejected immediately with a WeChat-devtools-style `fail` callback and a
 * `page-not-found` diagnostic — the simulator is never asked to navigate
 * there at all. `switchTab` additionally requires manifest-membership in
 * `tabBar.list`, with a distinct errMsg. `navigateBack` carries no page and is
 * never gated. The gate only applies when `manifest.source === 'app-config'`
 * (a real compiled manifest) — a `'fallback'` (unreachable app-config, single
 * page) manifest can't tell mountable from not, so it lets everything through
 * unchanged.
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

  let nextWcId = 8000
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
    nextWcId = 8000
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

import { BRIDGE_CHANNELS as C, SIMULATOR_EVENTS as E } from '../../shared/bridge-channels.js'
import type { MessageEnvelope, ServiceInvokePayload, SpawnRequest, SpawnResult, TabBarConfig } from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'

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
  tabBar?: TabBarConfig
}

function makeAppConfigResponse(fixture: AppConfigFixture): Response {
  const body = { app: { entryPagePath: fixture.entryPagePath, pages: fixture.pages, tabBar: fixture.tabBar } }
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

async function spawnSession(simulatorWc: MockWc, pagePath: string): Promise<{ result: SpawnResult; serviceWc: MockWc }> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  const req: SpawnRequest = { appId: 'nav-guard-app', pagePath, resourceBaseUrl: 'http://127.0.0.1:1/' }
  const result = (await (handle as AnyFn)({ sender: simulatorWc }, req)) as SpawnResult
  const serviceWc = stubs.wcById.get(result.serviceWcId)
  if (!serviceWc) throw new Error(`no mock webContents with id ${result.serviceWcId}`)
  return { result, serviceWc: serviceWc as unknown as MockWc }
}

function emitOn(channel: string, sender: unknown, payload: unknown): void {
  const fns = stubs.onListeners.get(channel)
  if (!fns) throw new Error(`no ipcMain.on listener for ${channel}`)
  for (const fn of [...fns]) fn({ sender }, payload)
}

/** Forwards a wx.* nav/tab API invocation from the service host through the router. */
function invokeApi(serviceWc: MockWc, bridgeId: string, name: string, params: Record<string, unknown>): void {
  const msg: MessageEnvelope = { type: 'invokeAPI', target: 'container', body: { name, params } }
  const payload: ServiceInvokePayload = { bridgeId, msg }
  emitOn(C.SERVICE_INVOKE, serviceWc, payload)
}

function navActionMessages(simulatorWc: MockWc): unknown[] {
  return simulatorWc.sentMessages.filter(m => m.channel === E.NAV_ACTION).map(m => m.payload)
}

function triggerCallbacks(serviceWc: MockWc): Array<{ id: unknown; args: unknown }> {
  return serviceWc.sentMessages
    .filter(m => m.channel === C.TO_SERVICE)
    .map(m => (m.payload as { msg?: MessageEnvelope }).msg)
    .filter((m): m is MessageEnvelope => !!m && m.type === 'triggerCallback')
    .map(m => m.body as { id: unknown; args: unknown })
}

const ENTRY_PAGE = 'pages/index/index'
const OTHER_PAGE = 'pages/other/other'
const TAB_PAGE = 'pages/home/home'
const BAD_PAGE = 'pages/removed/removed'

describe('bridge-router — navigateTo/redirectTo/reLaunch gate against the compiled manifest', () => {
  it.each(['navigateTo', 'redirectTo', 'reLaunch'] as const)(
    '%s: does not forward NAV_ACTION and fails the callback for a page absent from manifest.pages',
    async (api) => {
      installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] })
      const { ctx, simulatorWc } = makeCtx()
      installBridgeRouter(ctx)
      const { result, serviceWc } = await spawnSession(simulatorWc, ENTRY_PAGE)

      invokeApi(serviceWc, result.bridgeId, api, { url: `/${BAD_PAGE}`, success: 'ok-cb', fail: 'fail-cb', complete: 'complete-cb' })

      expect(navActionMessages(simulatorWc), `${api} must NOT reach the simulator for a missing page`).toHaveLength(0)

      const cbs = triggerCallbacks(serviceWc)
      const fail = cbs.find(c => c.id === 'fail-cb')
      expect(fail, `${api} must fail the service callback for a missing page`).toBeDefined()
      expect((fail!.args as { errMsg: string }).errMsg).toBe(`${api}:fail page "${BAD_PAGE}" is not found`)
      expect(cbs.find(c => c.id === 'complete-cb'), `${api}:fail must also fire complete`).toBeDefined()
      expect(cbs.find(c => c.id === 'ok-cb'), `${api} must not fire success for a missing page`).toBeUndefined()
    },
  )

  it.each(['navigateTo', 'redirectTo', 'reLaunch'] as const)(
    '%s: still forwards NAV_ACTION for a page present in manifest.pages, query and leading slash included',
    async (api) => {
      installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] })
      const { ctx, simulatorWc } = makeCtx()
      installBridgeRouter(ctx)
      const { result, serviceWc } = await spawnSession(simulatorWc, ENTRY_PAGE)

      invokeApi(serviceWc, result.bridgeId, api, { url: `/${OTHER_PAGE}?foo=1`, success: 'ok-cb', fail: 'fail-cb', complete: 'complete-cb' })

      expect(navActionMessages(simulatorWc), `${api} to a valid page must still reach the simulator`).toHaveLength(1)
      expect(triggerCallbacks(serviceWc).find(c => c.id === 'fail-cb')).toBeUndefined()
    },
  )

  it('navigateBack is never gated (carries no target page)', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const { result, serviceWc } = await spawnSession(simulatorWc, ENTRY_PAGE)

    invokeApi(serviceWc, result.bridgeId, 'navigateBack', { delta: 1, success: 'ok-cb', complete: 'complete-cb' })

    expect(navActionMessages(simulatorWc)).toHaveLength(1)
    expect(triggerCallbacks(serviceWc).find(c => c.id === 'fail-cb')).toBeUndefined()
  })

  it('reports a page-not-found diagnostic for a gated navigateTo', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE] })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const diagnostics: Array<{ severity: string; code: string; message: string }> = []
    ctx.diagnostics?.subscribe((d) => { diagnostics.push(d) }, { replay: false })
    const { result, serviceWc } = await spawnSession(simulatorWc, ENTRY_PAGE)

    invokeApi(serviceWc, result.bridgeId, 'navigateTo', { url: `/${BAD_PAGE}`, fail: 'fail-cb' })

    const entry = diagnostics.find(d => d.code === 'page-not-found')
    expect(entry, `expected a page-not-found diagnostic; got: ${JSON.stringify(diagnostics)}`).toBeDefined()
    expect(entry!.severity).toBe('error')
    expect(entry!.message).toContain(BAD_PAGE)
  })
})

describe('bridge-router — switchTab gate against manifest.pages AND tabBar.list', () => {
  const tabBar: TabBarConfig = { list: [{ pagePath: TAB_PAGE, text: 'Home' }] }

  it('fails with "is not found" for a switchTab target absent from manifest.pages entirely', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, TAB_PAGE], tabBar })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const { result, serviceWc } = await spawnSession(simulatorWc, ENTRY_PAGE)

    invokeApi(serviceWc, result.bridgeId, 'switchTab', { url: `/${BAD_PAGE}`, fail: 'fail-cb', complete: 'complete-cb' })

    expect(navActionMessages(simulatorWc)).toHaveLength(0)
    const fail = triggerCallbacks(serviceWc).find(c => c.id === 'fail-cb')
    expect(fail).toBeDefined()
    expect((fail!.args as { errMsg: string }).errMsg).toBe(`switchTab:fail page "${BAD_PAGE}" is not found`)
  })

  it('fails with "no-tabBar page" for a switchTab target present in pages but absent from tabBar.list', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, OTHER_PAGE, TAB_PAGE], tabBar })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const { result, serviceWc } = await spawnSession(simulatorWc, ENTRY_PAGE)

    invokeApi(serviceWc, result.bridgeId, 'switchTab', { url: `/${OTHER_PAGE}`, fail: 'fail-cb', complete: 'complete-cb' })

    expect(navActionMessages(simulatorWc)).toHaveLength(0)
    const fail = triggerCallbacks(serviceWc).find(c => c.id === 'fail-cb')
    expect(fail).toBeDefined()
    expect((fail!.args as { errMsg: string }).errMsg).toBe('switchTab:fail can not switch to no-tabBar page')
  })

  it('still forwards switchTab for a valid tabBar page', async () => {
    installFetchMock({ entryPagePath: ENTRY_PAGE, pages: [ENTRY_PAGE, TAB_PAGE], tabBar })
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const { result, serviceWc } = await spawnSession(simulatorWc, ENTRY_PAGE)

    invokeApi(serviceWc, result.bridgeId, 'switchTab', { url: `/${TAB_PAGE}`, fail: 'fail-cb' })

    expect(navActionMessages(simulatorWc)).toHaveLength(1)
    expect(triggerCallbacks(serviceWc).find(c => c.id === 'fail-cb')).toBeUndefined()
  })
})

describe('bridge-router — nav/tab gates are skipped for a "fallback" (unreachable app-config) manifest', () => {
  it('still forwards navigateTo to an arbitrary page when app-config.json was unreachable', async () => {
    installFetchMock(null)
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const { result, serviceWc } = await spawnSession(simulatorWc, ENTRY_PAGE)

    invokeApi(serviceWc, result.bridgeId, 'navigateTo', { url: `/${BAD_PAGE}`, fail: 'fail-cb' })

    expect(navActionMessages(simulatorWc), 'a fallback manifest cannot validate membership, so the gate must not block').toHaveLength(1)
    expect(triggerCallbacks(serviceWc).find(c => c.id === 'fail-cb')).toBeUndefined()
  })
})
