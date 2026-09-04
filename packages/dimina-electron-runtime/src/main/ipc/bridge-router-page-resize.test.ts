import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `bridge.setDevice()` is the only entry point for a device/orientation
 * change on native-host. Besides re-rendering the DeviceShell bezel via
 * DEVICE_CHANGE, it is what keeps a running service host current: without
 * its push `wx.getSystemInfoSync()` goes stale and `Page.onResize` never
 * fires. This suite pins that contract: a geometry change must push
 * `hostEnvUpdate` before `pageResize` to whichever page is currently visible,
 * only when a page is visible, and only when the geometry actually changed.
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

import { BRIDGE_CHANNELS as C, deviceInfoToHostEnv } from '../../shared/bridge-channels.js'
import type { SpawnResult } from '../../shared/bridge-channels.js'
import type { NativeDeviceInfo } from '../../shared/runtime-types.js'

// Loosely typed: `pageResize` is an existing `BridgeMessageType`, but
// `hostEnvUpdate` is not yet one — this suite is exactly what pins it down as
// part of the fix. Reading `wc.send`'s recorded calls this way keeps that
// gap a runtime assertion, not an unrelated compile error.
interface SentEnvelope {
  type: string
  target: string
  body: unknown
}
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

/** Every `TO_SERVICE` envelope the fake service webContents received, in arrival order. */
function toServiceMessages(serviceWc: FakeWc): SentEnvelope[] {
  return serviceWc.send.mock.calls
    .filter((call) => call[0] === C.TO_SERVICE)
    .map((call) => (call[1] as { msg: SentEnvelope }).msg)
}

function makeDevice(overrides: Partial<NativeDeviceInfo> = {}): NativeDeviceInfo {
  return {
    brand: 'Apple',
    model: 'iPhone 14',
    system: 'iOS 17',
    platform: 'ios',
    pixelRatio: 3,
    screenWidth: 390,
    screenHeight: 844,
    statusBarHeight: 47,
    notchType: 'notch',
    safeAreaInsets: { top: 47, right: 0, bottom: 34, left: 0 },
    ...overrides,
  }
}

// Different screenHeight/statusBarHeight => a different windowHeight, so the
// geometry compare must see this as a real change.
const LANDSCAPE_DEVICE = makeDevice({ screenWidth: 844, screenHeight: 390, statusBarHeight: 0 })

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

describe('bridge.setDevice — pushes hostEnvUpdate + pageResize to the visible page', () => {
  it('sends hostEnvUpdate before pageResize when the visible page changes device geometry', async () => {
    const s = await bootRootOnlySession()
    pageShow(s)
    s.ctx.bridge!.setDevice(LANDSCAPE_DEVICE)

    const messages = toServiceMessages(s.serviceWc)
    const hostEnvIndex = messages.findIndex((m) => m.type === 'hostEnvUpdate')
    const resizeIndex = messages.findIndex((m) => m.type === 'pageResize')
    expect(hostEnvIndex, 'hostEnvUpdate must reach the service host').toBeGreaterThanOrEqual(0)
    expect(resizeIndex, 'pageResize must reach the service host').toBeGreaterThan(hostEnvIndex)

    const expectedEnv = deviceInfoToHostEnv(LANDSCAPE_DEVICE)
    const resizeBody = messages[resizeIndex]!.body as {
      bridgeId: string
      size: { size: { windowWidth: number; windowHeight: number; screenWidth: number; screenHeight: number }; deviceOrientation: string }
    }
    expect(resizeBody.bridgeId).toBe(s.rootBridgeId)
    expect(resizeBody.size.size).toEqual({
      windowWidth: expectedEnv.windowWidth,
      windowHeight: expectedEnv.windowHeight,
      screenWidth: expectedEnv.screenWidth,
      screenHeight: expectedEnv.screenHeight,
    })
    expect(resizeBody.size.deviceOrientation).toBe('landscape')
  })

  it('does not send pageResize once the page that was visible has been hidden', async () => {
    const s = await bootRootOnlySession()
    pageShow(s)
    pageHide(s)
    s.ctx.bridge!.setDevice(LANDSCAPE_DEVICE)

    const messages = toServiceMessages(s.serviceWc)
    expect(messages.some((m) => m.type === 'pageResize')).toBe(false)
  })

  it('does not send a second pageResize when the new device has the same geometry as the current one', async () => {
    const s = await bootRootOnlySession()
    pageShow(s)
    s.ctx.bridge!.setDevice(LANDSCAPE_DEVICE)
    // Re-applying the identical geometry must not produce a second pageResize
    // — only an actual change should.
    s.ctx.bridge!.setDevice({ ...LANDSCAPE_DEVICE })

    const messages = toServiceMessages(s.serviceWc)
    const resizeCount = messages.filter((m) => m.type === 'pageResize').length
    expect(resizeCount, 'an unchanged geometry must not add a second pageResize').toBeLessThanOrEqual(1)
  })
})
