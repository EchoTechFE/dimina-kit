import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `handleSpawn` reads `ctx.bridge.getDevice()` once, synchronously, before
 * awaiting `loadAppConfig` — so a device switch that lands while that fetch
 * is in flight is never picked up by the spawn it interrupted. The resulting
 * service-host window is created with the device that was selected when the
 * spawn STARTED, not the one selected when app-config resolved. This pins the
 * spawn-time device to whichever one is current at the moment the window is
 * actually created (`createServiceHostWindow`'s `hostEnvSnapshot`).
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

/** Every `freshWindowOptions` object `createServiceHostWindow` was called with, in call order. */
const spawnWindowCalls = vi.hoisted(() => ({ options: [] as Array<{ hostEnvSnapshot?: { windowWidth?: number } }> }))

vi.mock('../windows/service-host-window/create.js', () => ({
  createServiceHostWindow: (opts: { hostEnvSnapshot?: { windowWidth?: number } }) => {
    spawnWindowCalls.options.push(opts)
    return fakes.createWindow()
  },
  navigateServiceHost: () => Promise.resolve(),
  buildServiceHostSpawnUrl: () => 'file:///service.html',
  serviceHostSpec: () => ({}),
}))

import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type { NativeDeviceInfo } from '../../shared/runtime-types.js'
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

function makeDevice(overrides: Partial<NativeDeviceInfo> = {}): NativeDeviceInfo {
  return {
    brand: 'Apple',
    model: 'iPhone 14',
    system: 'iOS 17',
    platform: 'ios',
    pixelRatio: 3,
    screenWidth: 375,
    screenHeight: 812,
    statusBarHeight: 47,
    notchType: 'notch',
    safeAreaInsets: { top: 47, right: 0, bottom: 34, left: 0 },
    ...overrides,
  }
}

// windowWidth mirrors screenWidth 1:1 (deviceInfoToHostEnv) — 375 vs 430 are
// unambiguous enough to tell "captured at spawn start" from "captured at
// window-creation time" apart.
const DEVICE_A = makeDevice({ screenWidth: 375, screenHeight: 812 })
const DEVICE_B = makeDevice({ screenWidth: 430, screenHeight: 932 })

beforeEach(() => {
  spawnWindowCalls.options.length = 0
})

afterEach(async () => {
  for (const registry of openRegistries.splice(0)) await registry.dispose()
  electronStubs.handlers.clear()
  electronStubs.sync.removeAllListeners()
  fakes.reset()
  vi.unstubAllGlobals()
  __resetMiniappSessionConfigForTests()
})

describe('handleSpawn — device selected while app-config is still loading', () => {
  it('uses the device current when the service-host window is created, not the one at spawn start (fresh path)', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    ctx.bridge!.setDevice(DEVICE_A)

    let releaseFetch!: () => void
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve })
    vi.stubGlobal('fetch', vi.fn(async () => {
      await fetchGate
      return new Response(JSON.stringify(APP_CONFIG))
    }))

    const spawnPromise = invokeHandler(C.SPAWN, simulatorWc, {
      appId: 'app-1',
      pagePath: ROOT_PAGE,
      resourceBaseUrl: 'http://127.0.0.1:65535/',
    })

    // The spawn is now blocked inside loadAppConfig's fetch — switch the
    // device before letting it resolve.
    ctx.bridge!.setDevice(DEVICE_B)
    releaseFetch()
    await spawnPromise

    const created = spawnWindowCalls.options[spawnWindowCalls.options.length - 1]
    expect(created?.hostEnvSnapshot?.windowWidth).toBe(DEVICE_B.screenWidth)
  })
})
