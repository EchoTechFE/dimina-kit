import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `forwardToService` only checks `serviceWc.isDestroyed()` before calling
 * `send` — there is no gate on whether the service host has actually loaded
 * and installed its `TO_SERVICE` listener yet. `handleSpawn` does not await
 * the service window's `did-finish-load`; it fires asynchronously later
 * (`bootServiceHost`), and the pooled/fresh warm preload has no `bridgeId`
 * yet so it never installs a listener. A page-lifecycle message (pageShow)
 * that lands in that window is handed to Electron's `send` with nobody
 * listening on the other side and is gone for good — Electron does not queue
 * it, and nothing here retries it. This suite pins the fix as an observable
 * contract: a message that arrives before the service host is ready must
 * still reach it, in order, once it becomes ready — and must never be
 * replayed onto a session that was disposed before that happened.
 */
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
    getURL: () => 'file:///service.html',
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

vi.mock('../windows/service-host-window/create.js', () => ({
  createServiceHostWindow: () => fakes.createWindow(),
  navigateServiceHost: () => Promise.resolve(),
  buildServiceHostSpawnUrl: () => 'file:///service.html',
  serviceHostSpec: () => ({}),
}))

import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type { SpawnResult } from '../../shared/bridge-channels.js'
import { __resetMiniappSessionConfigForTests } from '../services/views/miniapp-partition.js'
import { installBridgeRouter } from './bridge-router.js'
import type { RuntimeContext } from '../runtime-context.js'

type FakeWc = ReturnType<typeof fakes.makeWc>

const ROOT_PAGE = 'pages/index/index'
const APP_CONFIG = { app: { entryPagePath: ROOT_PAGE, pages: [ROOT_PAGE] }, modules: {} }

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
    connections: { acquire: () => ({ own: vi.fn() }), get: vi.fn(), reset: vi.fn() },
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

interface SentEnvelope {
  type: string
  target: string
  body: unknown
}

/** Every `TO_SERVICE` envelope the fake service webContents received, in arrival order. */
function toServiceMessages(serviceWc: FakeWc): SentEnvelope[] {
  return serviceWc.send.mock.calls
    .filter((call) => call[0] === C.TO_SERVICE)
    .map((call) => (call[1] as { msg: SentEnvelope }).msg)
}

interface Session {
  ctx: RuntimeContext
  simulatorWc: FakeWc
  serviceWc: FakeWc
  appSessionId: string
  rootBridgeId: string
}

async function bootRootOnlySession(): Promise<Session> {
  const { ctx, simulatorWc } = makeCtx()
  installBridgeRouter(ctx)
  const spawn = (await invokeHandler(C.SPAWN, simulatorWc, {
    appId: 'app-1',
    pagePath: ROOT_PAGE,
    resourceBaseUrl: 'http://127.0.0.1:65535/',
  })) as SpawnResult
  const serviceWc = fakes.windows[fakes.windows.length - 1]!.webContents
  return { ctx, simulatorWc, serviceWc, appSessionId: spawn.appSessionId, rootBridgeId: spawn.bridgeId }
}

function pageShow(s: Session, bridgeId = s.rootBridgeId): void {
  emitSync(C.PAGE_LIFECYCLE, s.simulatorWc, { appSessionId: s.appSessionId, bridgeId, event: 'pageShow' })
}

function pageHide(s: Session, bridgeId = s.rootBridgeId): void {
  emitSync(C.PAGE_LIFECYCLE, s.simulatorWc, { appSessionId: s.appSessionId, bridgeId, event: 'pageHide' })
}

function dispose(s: Session): void {
  emitSync(C.DISPOSE, s.simulatorWc, { bridgeId: s.rootBridgeId })
}

/**
 * The service window's own `did-finish-load` handler that boots the service
 * host (`bootServiceHost`) — registered with `.once` on the fresh (non-pooled)
 * path this fake ctx always takes. Firing it is what real navigation
 * completing looks like from main's perspective.
 */
function fireServiceDidFinishLoad(s: Session): void {
  const call = s.serviceWc.once.mock.calls.find(([channel]) => channel === 'did-finish-load')
  if (!call) throw new Error('service webContents never registered a did-finish-load listener')
  ;(call[1] as () => void)()
}

/** Waits for `bootServiceHost` (kicked off by `fireServiceDidFinishLoad`) to run to completion. */
async function waitForServiceBootSettled(s: Session): Promise<void> {
  await vi.waitFor(() => {
    if (!toServiceMessages(s.serviceWc).some((m) => m.type === 'loadResource')) {
      throw new Error('bootServiceHost has not sent its root-page loadResource yet')
    }
  })
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(APP_CONFIG)))))
})

afterEach(async () => {
  for (const registry of openRegistries.splice(0)) await registry.dispose()
  electronStubs.handlers.clear()
  electronStubs.sync.removeAllListeners()
  fakes.reset()
  vi.unstubAllGlobals()
  __resetMiniappSessionConfigForTests()
})

describe('forwardToService — messages that arrive before the service host is ready', () => {
  it('does not lose a pageShow sent before did-finish-load: it is delivered once the service host boots', async () => {
    const s = await bootRootOnlySession()

    // The service window has not fired did-finish-load yet — nothing has run
    // bootServiceHost, so no preload on the other side has installed a
    // TO_SERVICE listener. A pageShow landing here today is sent immediately
    // anyway and is gone for good.
    pageShow(s)
    expect(
      toServiceMessages(s.serviceWc).some((m) => m.type === 'pageShow'),
      'pageShow must not be handed to a service window that has not become ready yet',
    ).toBe(false)

    fireServiceDidFinishLoad(s)
    await waitForServiceBootSettled(s)

    const delivered = toServiceMessages(s.serviceWc).find((m) => m.type === 'pageShow')
    expect(delivered, 'the pageShow must still reach the service host once it is ready').toBeDefined()
    expect((delivered?.body as { bridgeId: string }).bridgeId).toBe(s.rootBridgeId)
  })

  it('preserves the relative order of several messages queued before readiness', async () => {
    const s = await bootRootOnlySession()

    pageShow(s)
    pageHide(s)

    fireServiceDidFinishLoad(s)
    await waitForServiceBootSettled(s)

    const types = toServiceMessages(s.serviceWc).map((m) => m.type)
    const showIndex = types.indexOf('pageShow')
    const hideIndex = types.indexOf('pageHide')
    expect(showIndex, 'pageShow must have been delivered').toBeGreaterThanOrEqual(0)
    expect(hideIndex, 'pageHide must have been delivered').toBeGreaterThanOrEqual(0)
    expect(hideIndex, 'pageHide must not overtake the pageShow that preceded it').toBeGreaterThan(showIndex)
  })

  it('delivers a message immediately once the service host is already ready (no artificial delay)', async () => {
    const s = await bootRootOnlySession()
    fireServiceDidFinishLoad(s)
    await waitForServiceBootSettled(s)

    const beforeCount = toServiceMessages(s.serviceWc).length
    pageShow(s)

    // No await between the call and this assertion: an already-ready session
    // must forward synchronously, the same as it does today, so a fix for the
    // pre-ready case cannot regress the common case into a queued/delayed send.
    const messages = toServiceMessages(s.serviceWc)
    expect(messages.length).toBeGreaterThan(beforeCount)
    expect(messages[messages.length - 1]?.type).toBe('pageShow')
  })

  it('never replays a queued message onto a session disposed before it became ready', async () => {
    const s = await bootRootOnlySession()

    pageShow(s)
    expect(
      toServiceMessages(s.serviceWc).some((m) => m.type === 'pageShow'),
      'pageShow must not have been sent to the not-yet-ready service host',
    ).toBe(false)

    // The session is torn down before the service host ever became ready —
    // e.g. the project window closed mid-launch. A late/stale did-finish-load
    // firing afterward (the real Electron event can still be in flight) must
    // not resurrect the queued message onto a dead or pool-recycled window.
    dispose(s)
    fireServiceDidFinishLoad(s)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(
      toServiceMessages(s.serviceWc).some((m) => m.type === 'pageShow'),
      'a disposed session must never have its queued pageShow delivered',
    ).toBe(false)
  })
})
