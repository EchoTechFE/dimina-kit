import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronStubs = vi.hoisted(() => {
  type SyncListener = (...args: unknown[]) => void
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const syncListeners = new Map<string, SyncListener[]>()
  const sync = {
    on(channel: string, listener: SyncListener) {
      const list = syncListeners.get(channel) ?? []
      list.push(listener)
      syncListeners.set(channel, list)
    },
    removeListener(channel: string, listener: SyncListener) {
      const list = syncListeners.get(channel)
      if (!list) return
      const at = list.indexOf(listener)
      if (at !== -1) list.splice(at, 1)
    },
    listenerCount: (channel: string) => syncListeners.get(channel)?.length ?? 0,
    emit(channel: string, ...args: unknown[]) {
      for (const listener of [...(syncListeners.get(channel) ?? [])]) listener(...args)
    },
    removeAllListeners() {
      syncListeners.clear()
    },
  }
  const ipcMain = {
    handle(channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) {
      // Verbatim Electron behaviour: one handler per channel, process-wide.
      if (handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`)
      }
      handlers.set(channel, fn)
    },
    removeHandler(channel: string) {
      handlers.delete(channel)
    },
    on(channel: string, listener: (...args: unknown[]) => void) {
      sync.on(channel, listener)
      return ipcMain
    },
    removeListener(channel: string, listener: (...args: unknown[]) => void) {
      sync.removeListener(channel, listener)
      return ipcMain
    },
    listenerCount: (channel: string) => sync.listenerCount(channel),
  }
  const makeProtocolStub = () => ({
    handle: vi.fn(),
    unhandle: vi.fn(),
    registerSchemesAsPrivileged: vi.fn(),
  })
  const protocolStub = makeProtocolStub()
  const fromPartition = () => ({
    protocol: makeProtocolStub(),
    setPermissionRequestHandler: vi.fn(),
    webRequest: { onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() },
  })
  return { handlers, sync, ipcMain, protocolStub, fromPartition }
})

vi.mock('electron', () => ({
  app: { isReady: () => true, on: vi.fn(), getLocale: () => 'zh-CN' },
  BrowserWindow: class {},
  ipcMain: electronStubs.ipcMain,
  protocol: electronStubs.protocolStub,
  session: { fromPartition: electronStubs.fromPartition },
  webContents: { fromId: () => null, getAllWebContents: () => [] },
  default: {},
}))

vi.mock('../services/dmb-resource/handle-request.js', () => ({
  handleDmbResourceRequest: () => Promise.resolve(new Response('')),
}))

// The webContents/window fakes live in the hoisted block because the
// service-host module mock below constructs one, and mock factories are
// hoisted above the module body.
const fakes = vi.hoisted(() => {
  let nextWcId = 1
  const makeWc = (host?: unknown) => ({
    id: nextWcId++,
    isDestroyed: () => false,
    send: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    executeJavaScript: vi.fn(() => Promise.resolve()),
    close: vi.fn(),
    hostWebContents: host,
  })
  const windows: Array<{ webContents: ReturnType<typeof makeWc> }> = []
  const createWindow = () => {
    const win = {
      webContents: makeWc(),
      isDestroyed: () => false,
      close: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
    }
    windows.push(win)
    return win
  }
  const reset = () => {
    nextWcId = 1
    windows.length = 0
  }
  return { makeWc, windows, createWindow, reset }
})

// A spawn constructs a real hidden BrowserWindow and navigates it. The router
// only ever `send`s to its webContents and hangs listeners on it, so a fake
// window carries the whole spawn without an Electron runtime.
vi.mock('../windows/service-host-window/create.js', () => ({
  createServiceHostWindow: () => fakes.createWindow(),
  navigateServiceHost: () => Promise.resolve(),
  buildServiceHostSpawnUrl: () => 'file:///service.html',
  serviceHostSpec: () => ({}),
}))

import { BRIDGE_CHANNELS as C, SIMULATOR_EVENTS as E } from '../../shared/bridge-channels.js'
import type {
  ApiCallPayload,
  MessageEnvelope,
  NavActionPayload,
  PageOpenResult,
  SpawnResult,
} from '../../shared/bridge-channels.js'
import { __resetMiniappSessionConfigForTests } from '../services/views/miniapp-partition.js'
import { installBridgeRouter } from './bridge-router.js'
import type { RuntimeContext } from '../runtime-context.js'

type FakeWc = ReturnType<typeof fakes.makeWc>

const ROOT_PAGE = 'pages/index/index'
const DETAIL_PAGE = 'pages/detail/detail'

const APP_CONFIG = {
  app: { entryPagePath: ROOT_PAGE, pages: [ROOT_PAGE, DETAIL_PAGE] },
  modules: {},
}

class FakeRegistry {
  private readonly disposers: Array<() => unknown> = []
  add(value: { dispose(): unknown } | (() => unknown)) {
    const dispose = typeof value === 'function' ? value : () => value.dispose()
    this.disposers.push(dispose)
    return { dispose }
  }
  async dispose() {
    for (const dispose of this.disposers.reverse()) await dispose()
    this.disposers.length = 0
  }
}

const openRegistries: FakeRegistry[] = []

function makeCtx(): { ctx: RuntimeContext; simulatorWc: FakeWc } {
  const windowWc = fakes.makeWc()
  // The simulator is a <webview> guest of the workbench window, which is how
  // the ipc mux attributes its SPAWN/PAGE_OPEN traffic to this router.
  const simulatorWc = fakes.makeWc(windowWc)
  const registry = new FakeRegistry()
  openRegistries.push(registry)
  const ctx = {
    apiNamespaces: [],
    assets: {
      root: '/runtime/dist',
      simulatorDir: '/runtime/dist/simulator',
      simulatorPreloadPath: '/runtime/dist/preload/simulator.cjs',
      renderHostHtmlPath: '/runtime/dist/render-host/pageFrame.html',
      renderHostPreloadPath: '/runtime/dist/render-host/preload.cjs',
      serviceHostHtmlPath: '/runtime/dist/service-host/service.html',
      serviceHostPreloadPath: '/runtime/dist/service-host/preload.cjs',
    },
    workspace: {
      getSession: () => null,
      getProjectPath: () => '/project',
      isClosing: () => false,
    },
    windows: {
      mainWindow: {
        webContents: windowWc,
        isDestroyed: () => false,
        contentView: { children: [] },
        on: vi.fn(),
        off: vi.fn(),
        removeListener: vi.fn(),
      },
    },
    registry,
    connections: {
      acquire: () => ({ own: vi.fn() }),
      get: vi.fn(),
      reset: vi.fn(),
    },
    simulatorApis: { invoke: vi.fn(), list: () => [], has: () => false },
    events: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
  } as unknown as RuntimeContext
  return { ctx, simulatorWc }
}

function invokeHandler(channel: string, sender: FakeWc, payload: unknown): Promise<unknown> {
  const handler = electronStubs.handlers.get(channel)
  if (!handler) throw new Error(`no handler on ${channel}`)
  return Promise.resolve(handler({ sender }, payload))
}

function emitSync(channel: string, sender: FakeWc, payload: unknown): void {
  electronStubs.sync.emit(channel, { sender }, payload)
}

/** Everything `wc.send` was given on `channel`, oldest first. */
function sendsOn(wc: FakeWc, channel: string): unknown[] {
  return wc.send.mock.calls.filter(call => call[0] === channel).map(call => call[1])
}

/** The `triggerCallback` bodies that actually reached the service host. */
function serviceCallbacks(serviceWc: FakeWc): Array<{ id: unknown; args: unknown }> {
  return sendsOn(serviceWc, C.TO_SERVICE)
    .map(payload => (payload as { msg: MessageEnvelope }).msg)
    .filter(msg => msg.type === 'triggerCallback')
    .map(msg => msg.body as unknown as { id: unknown; args: unknown })
}

/** Drive a container API the way the service-host preload does: one fixed bridgeId for the window's whole life. */
// Verbatim what the service preload sends: no page id of its own. The host
// serves the whole page stack, so a call that concerns one page names it in
// `msg.body.bridgeId`; these calls name none.
function serviceInvokeApi(serviceWc: FakeWc, body: Record<string, unknown>): void {
  emitSync(C.SERVICE_INVOKE, serviceWc, {
    msg: { type: 'invokeAPI', target: 'container', body },
  })
}

interface Session {
  simulatorWc: FakeWc
  serviceWc: FakeWc
  rootBridgeId: string
  rootRenderWc: FakeWc
  detailBridgeId: string
  detailRenderWc: FakeWc
}

/**
 * A session whose page stack is root + one navigated-to page, both with a live
 * render guest, with the DeviceShell already reporting the navigated-to page as
 * the top of the stack.
 */
async function bootTwoPageSession(): Promise<Session> {
  const { ctx, simulatorWc } = makeCtx()
  installBridgeRouter(ctx)

  const { serviceWc, rootBridgeId, rootRenderWc, appSessionId, newBridgeId, newRenderWc } =
    await spawnRootAndOpenSecond(simulatorWc, 'app-1')

  emitSync(C.ACTIVE_PAGE, simulatorWc, { appSessionId, bridgeId: newBridgeId })

  return { simulatorWc, serviceWc, rootBridgeId, rootRenderWc, detailBridgeId: newBridgeId, detailRenderWc: newRenderWc }
}

/** Close the session's root page through the simulator's own PAGE_CLOSE — the teardown reLaunch/redirectTo/switchTab reach. */
function closeRootPage(s: Session): void {
  emitSync(C.PAGE_CLOSE, s.simulatorWc, { bridgeId: s.rootBridgeId })
}

/** The render guest's self-announcement that binds its webContents to a page session. */
function announceRenderGuest(wc: FakeWc, bridgeId: string): void {
  emitSync(C.RENDER_INVOKE, wc, {
    bridgeId,
    msg: { type: 'renderHostReady', target: 'container', body: { bridgeId } },
  })
}

interface RootOnlySession {
  simulatorWc: FakeWc
  serviceWc: FakeWc
  rootBridgeId: string
  rootRenderWc: FakeWc
}

/** Spawns appId's root page on an already-installed router, with its render guest bound. */
async function spawnRoot(simulatorWc: FakeWc, appId: string): Promise<Omit<RootOnlySession, 'simulatorWc'> & { appSessionId: string }> {
  const spawn = await invokeHandler(C.SPAWN, simulatorWc, {
    appId,
    pagePath: ROOT_PAGE,
    resourceBaseUrl: 'http://127.0.0.1:65535/',
  }) as SpawnResult
  const serviceWc = fakes.windows[fakes.windows.length - 1]!.webContents
  const rootRenderWc = fakes.makeWc()
  announceRenderGuest(rootRenderWc, spawn.bridgeId)
  return { serviceWc, rootBridgeId: spawn.bridgeId, rootRenderWc, appSessionId: spawn.appSessionId }
}

/** spawnRoot, then navigates to a second page with its own render guest bound — no ACTIVE_PAGE report yet. */
async function spawnRootAndOpenSecond(
  simulatorWc: FakeWc,
  appId: string,
): Promise<Omit<RootOnlySession, 'simulatorWc'> & { appSessionId: string; newBridgeId: string; newRenderWc: FakeWc }> {
  const root = await spawnRoot(simulatorWc, appId)
  const opened = await invokeHandler(C.PAGE_OPEN, simulatorWc, {
    appSessionId: root.appSessionId,
    pagePath: DETAIL_PAGE,
  }) as PageOpenResult
  const newRenderWc = fakes.makeWc()
  announceRenderGuest(newRenderWc, opened.bridgeId)
  return { ...root, newBridgeId: opened.bridgeId, newRenderWc }
}

/** A fresh session with only its root page, root render guest bound, no navigation and no ACTIVE_PAGE report yet. */
async function bootRootOnlySession(appId = 'app-1'): Promise<RootOnlySession> {
  const { ctx, simulatorWc } = makeCtx()
  installBridgeRouter(ctx)
  return { simulatorWc, ...await spawnRoot(simulatorWc, appId) }
}

/** Two independent app sessions sharing one simulator webview, each with only its root page. */
async function bootTwoIndependentSessions(): Promise<{ a: RootOnlySession; b: RootOnlySession }> {
  const { ctx, simulatorWc } = makeCtx()
  installBridgeRouter(ctx)
  const a = { simulatorWc, ...await spawnRoot(simulatorWc, 'app-1') }
  const b = { simulatorWc, ...await spawnRoot(simulatorWc, 'app-2') }
  return { a, b }
}

interface ReLaunchGapSession {
  serviceWc: FakeWc
  rootRenderWc: FakeWc
  newBridgeId: string
  newRenderWc: FakeWc
}

/**
 * A session mid-reLaunch: the old root and a newly opened page both have live
 * render guests, but root has just closed and the shell has not yet reported
 * the new page as ACTIVE_PAGE. PAGE_CLOSE refuses to close a session's sole
 * page (that is DISPOSE's job), so this gap only exists once a second page is
 * already open to close root against — the same shape reLaunch produces
 * before the shell catches up.
 */
async function bootReLaunchGapSession(): Promise<ReLaunchGapSession> {
  const { ctx, simulatorWc } = makeCtx()
  installBridgeRouter(ctx)

  const { serviceWc, rootBridgeId, rootRenderWc, newBridgeId, newRenderWc } =
    await spawnRootAndOpenSecond(simulatorWc, 'app-1')

  emitSync(C.PAGE_CLOSE, simulatorWc, { bridgeId: rootBridgeId })

  return { serviceWc, rootRenderWc, newBridgeId, newRenderWc }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(APP_CONFIG)))))
})

afterEach(async () => {
  for (const registry of openRegistries.splice(0)) await registry.dispose()
  electronStubs.handlers.clear()
  electronStubs.sync.removeAllListeners()
  electronStubs.protocolStub.handle.mockClear()
  electronStubs.protocolStub.unhandle.mockClear()
  fakes.reset()
  vi.unstubAllGlobals()
  __resetMiniappSessionConfigForTests()
})

describe('service→container messages after the session root page is gone', () => {
  it('still acts on the surviving page and answers the caller', async () => {
    const s = await bootTwoPageSession()
    closeRootPage(s)

    serviceInvokeApi(s.serviceWc, {
      name: 'pageScrollTo',
      params: { scrollTop: 120, success: 'cb-success', complete: 'cb-complete' },
    })

    expect(s.detailRenderWc.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(s.rootRenderWc.executeJavaScript).not.toHaveBeenCalled()
    expect(serviceCallbacks(s.serviceWc)).toEqual([
      { id: 'cb-success', args: { errMsg: 'pageScrollTo:ok' } },
      { id: 'cb-complete', args: { errMsg: 'pageScrollTo:ok' } },
    ])
  })

  it('still navigates, naming the surviving page as the navigation source', async () => {
    const s = await bootTwoPageSession()
    closeRootPage(s)

    serviceInvokeApi(s.serviceWc, {
      name: 'navigateTo',
      params: { url: `/${DETAIL_PAGE}`, success: 'cb-success' },
    })

    const navActions = sendsOn(s.simulatorWc, E.NAV_ACTION) as NavActionPayload[]
    expect(navActions).toHaveLength(1)
    expect(navActions[0]!.name).toBe('navigateTo')
    expect(navActions[0]!.bridgeId).toBe(s.detailBridgeId)
  })

  it('completes a simulator-served API round trip back to the service host', async () => {
    const s = await bootTwoPageSession()
    closeRootPage(s)

    serviceInvokeApi(s.serviceWc, {
      name: 'getSystemInfo',
      params: { success: 'cb-success', complete: 'cb-complete' },
    })

    const apiCalls = sendsOn(s.simulatorWc, E.API_CALL) as ApiCallPayload[]
    expect(apiCalls).toHaveLength(1)
    expect(apiCalls[0]!.bridgeId).toBe(s.detailBridgeId)

    emitSync(C.API_RESPONSE, s.simulatorWc, {
      appSessionId: apiCalls[0]!.appSessionId,
      requestId: apiCalls[0]!.requestId,
      ok: true,
      result: { brand: 'devtools' },
    })

    expect(serviceCallbacks(s.serviceWc)).toEqual([
      { id: 'cb-success', args: { brand: 'devtools' } },
      { id: 'cb-complete', args: { brand: 'devtools' } },
    ])
  })
})

// Every case below drives the same pageScrollTo call; only who it should
// reach (or whether it should reach anyone) varies.
const SCROLL_PARAMS = { scrollTop: 40, success: 'cb-success', complete: 'cb-complete' }
const SCROLL_OK_CALLBACKS = [
  { id: 'cb-success', args: { errMsg: 'pageScrollTo:ok' } },
  { id: 'cb-complete', args: { errMsg: 'pageScrollTo:ok' } },
]

describe('service→container routing: msg.body.bridgeId vs. the session’s reported top of stack', () => {
  it('routes to the page msg.body.bridgeId names even when another page is the reported top', async () => {
    const s = await bootTwoPageSession() // ACTIVE_PAGE already reports detail as top

    serviceInvokeApi(s.serviceWc, { bridgeId: s.rootBridgeId, name: 'pageScrollTo', params: SCROLL_PARAMS })

    expect(s.rootRenderWc.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(s.detailRenderWc.executeJavaScript).not.toHaveBeenCalled()
  })

  it('falls back to the reported top of stack when the named page id is already closed', async () => {
    const s = await bootTwoPageSession()
    closeRootPage(s) // root is gone; ACTIVE_PAGE already named detail as top

    // bridgeId names a page that no longer exists.
    serviceInvokeApi(s.serviceWc, { bridgeId: s.rootBridgeId, name: 'pageScrollTo', params: SCROLL_PARAMS })

    expect(s.detailRenderWc.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(serviceCallbacks(s.serviceWc)).toEqual(SCROLL_OK_CALLBACKS)
  })

  it('routes an unnamed call to the root page while the shell has never reported ACTIVE_PAGE', async () => {
    const s = await bootRootOnlySession()

    serviceInvokeApi(s.serviceWc, { name: 'pageScrollTo', params: SCROLL_PARAMS })

    expect(s.rootRenderWc.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(serviceCallbacks(s.serviceWc)).toEqual(SCROLL_OK_CALLBACKS)
  })

  it('drops an unnamed call without throwing once the root is gone and no new top has been reported', async () => {
    const s = await bootReLaunchGapSession()

    expect(() => serviceInvokeApi(s.serviceWc, { name: 'pageScrollTo', params: SCROLL_PARAMS })).not.toThrow()

    expect(s.rootRenderWc.executeJavaScript).not.toHaveBeenCalled()
    expect(s.newRenderWc.executeJavaScript).not.toHaveBeenCalled()
    expect(serviceCallbacks(s.serviceWc)).toEqual([])
  })

  it('routes to a page already open but not yet reported active, in the reLaunch gap after the old root closes', async () => {
    const s = await bootReLaunchGapSession()

    // An unnamed call would have nothing to fall back to here (see previous
    // test) — naming the new page directly must still land.
    serviceInvokeApi(s.serviceWc, { bridgeId: s.newBridgeId, name: 'pageScrollTo', params: SCROLL_PARAMS })

    expect(s.newRenderWc.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(serviceCallbacks(s.serviceWc)).toEqual(SCROLL_OK_CALLBACKS)
  })

  it('does not resolve a bridgeId that belongs to another app session', async () => {
    const { a, b } = await bootTwoIndependentSessions()

    // b.rootBridgeId names a real page, but in the other session.
    serviceInvokeApi(a.serviceWc, { bridgeId: b.rootBridgeId, name: 'pageScrollTo', params: SCROLL_PARAMS })

    expect(a.rootRenderWc.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(b.rootRenderWc.executeJavaScript).not.toHaveBeenCalled()
  })
})
