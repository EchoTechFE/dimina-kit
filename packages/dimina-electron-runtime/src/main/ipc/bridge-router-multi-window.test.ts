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
  // A protocol registrar (the default `protocol`, or a session's) tracks what is
  // currently installed so a test can tell "handler replaced" from "handler
  // removed", and can run the live handler.
  const makeProtocolStub = () => {
    const installed = new Map<string, (request: { url: string }) => unknown>()
    return {
      installed,
      handle: vi.fn((scheme: string, fn: (request: { url: string }) => unknown) => {
        installed.set(scheme, fn)
      }),
      unhandle: vi.fn((scheme: string) => {
        installed.delete(scheme)
      }),
      registerSchemesAsPrivileged: vi.fn(),
    }
  }
  const protocolStub = makeProtocolStub()
  const sessions = new Map<string, { protocol: ReturnType<typeof makeProtocolStub> }>()
  const fromPartition = (partition: string) => {
    let sess = sessions.get(partition)
    if (!sess) {
      sess = {
        protocol: makeProtocolStub(),
        setPermissionRequestHandler: vi.fn(),
        webRequest: { onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() },
      } as unknown as { protocol: ReturnType<typeof makeProtocolStub> }
      sessions.set(partition, sess)
    }
    return sess
  }
  return { handlers, sync, ipcMain, protocolStub, sessions, fromPartition }
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

const dmbResourceSpy = vi.hoisted(() => vi.fn())
vi.mock('../services/dmb-resource/handle-request.js', () => ({
  handleDmbResourceRequest: (input: { sdkRoot: string }) => {
    dmbResourceSpy(input)
    return Promise.resolve(new Response(input.sdkRoot))
  },
}))

import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type { NativeHostConfig } from '../../shared/bridge-channels.js'
import type { NativeDeviceInfo } from '../../shared/runtime-types.js'
import {
  SHARED_MINIAPP_PARTITION,
  __resetMiniappSessionConfigForTests,
} from '../services/views/miniapp-partition.js'
import { routerOwnsSender } from './bridge-router-ipc-mux.js'
import { installBridgeRouter } from './bridge-router.js'
import type { RuntimeContext } from '../runtime-context.js'

let nextWcId = 1

interface FakeWc {
  id: number
  isDestroyed: () => boolean
  send: ReturnType<typeof vi.fn>
  hostWebContents?: FakeWc
}

function fakeWc(host?: FakeWc): FakeWc {
  return { id: nextWcId++, isDestroyed: () => false, send: vi.fn(), hostWebContents: host }
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

interface FakeView {
  children: FakeView[]
  webContents?: FakeWc
}

interface TestCtx {
  ctx: RuntimeContext
  windowWc: FakeWc
  contentView: FakeView
  projectPath: ReturnType<typeof vi.fn>
  registry: FakeRegistry
}

const assets = {
  root: '/runtime/dist',
  simulatorDir: '/runtime/dist/simulator',
  simulatorPreloadPath: '/runtime/dist/preload/simulator.cjs',
  renderHostHtmlPath: '/runtime/dist/render-host/pageFrame.html',
  renderHostPreloadPath: '/runtime/dist/render-host/preload.cjs',
  serviceHostHtmlPath: '/runtime/dist/service-host/service.html',
  serviceHostPreloadPath: '/runtime/dist/service-host/preload.cjs',
}

const openCtxs: TestCtx[] = []

function makeCtx(label: string): TestCtx {
  const windowWc = fakeWc()
  const contentView: FakeView = { children: [] }
  // `getProjectPath` is the first ctx-owned call `handleSpawn` makes, so a
  // throwing spy names the router that actually took the invoke.
  const projectPath = vi.fn(() => {
    throw new Error(`spawn-probe:${label}`)
  })
  const registry = new FakeRegistry()
  const ctx = {
    apiNamespaces: [],
    // Each window resolves its own runtime dist, so `sdkRoot` names the router
    // that served a dmb-resource request.
    assets: { ...assets, root: `/runtime/${label}` },
    workspace: {
      getSession: () => null,
      getProjectPath: projectPath,
      isClosing: () => false,
    },
    windows: {
      mainWindow: {
        webContents: windowWc,
        isDestroyed: () => false,
        contentView,
        on: vi.fn(),
        off: vi.fn(),
        removeListener: vi.fn(),
      },
    },
    registry,
    connections: { acquire: vi.fn(), get: vi.fn() },
    simulatorApis: { invoke: vi.fn(async () => label), list: () => [] },
    events: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
  } as unknown as RuntimeContext
  const entry: TestCtx = { ctx, windowWc, contentView, projectPath, registry }
  openCtxs.push(entry)
  return entry
}

function invokeSpawn(sender: FakeWc): Promise<unknown> {
  const handler = electronStubs.handlers.get(C.SPAWN)
  if (!handler) throw new Error(`no handler on ${C.SPAWN}`)
  return Promise.resolve(handler({ sender }, { appId: 'app-1', pagePath: 'pages/index/index' }))
}

beforeEach(() => {
  nextWcId = 1
})

afterEach(async () => {
  for (const entry of openCtxs.splice(0)) await entry.registry.dispose()
  electronStubs.handlers.clear()
  electronStubs.sync.removeAllListeners()
  electronStubs.protocolStub.handle.mockClear()
  electronStubs.protocolStub.unhandle.mockClear()
  electronStubs.protocolStub.installed.clear()
  electronStubs.sessions.clear()
  dmbResourceSpy.mockClear()
  __resetMiniappSessionConfigForTests()
})

describe('installBridgeRouter across several workbench windows', () => {
  it('installs twice in one process without colliding on the invoke channels', () => {
    const a = makeCtx('A')
    const b = makeCtx('B')
    installBridgeRouter(a.ctx)
    expect(() => installBridgeRouter(b.ctx)).not.toThrow()
  })

  it('routes SPAWN from a <webview> guest to the router owning its window', async () => {
    const a = makeCtx('A')
    const b = makeCtx('B')
    installBridgeRouter(a.ctx)
    installBridgeRouter(b.ctx)

    // Default architecture: the simulator is a `<webview>` guest, so the guest's
    // `hostWebContents` is its window's renderer.
    await expect(invokeSpawn(fakeWc(b.windowWc))).rejects.toThrow('spawn-probe:B')
    expect(a.projectPath).not.toHaveBeenCalled()

    // The router installed FIRST must still get its own window's traffic.
    await expect(invokeSpawn(fakeWc(a.windowWc))).rejects.toThrow('spawn-probe:A')
    expect(b.projectPath).toHaveBeenCalledTimes(1)
  })

  it('routes SPAWN from a WebContentsView child to the router owning its window', async () => {
    const a = makeCtx('A')
    const b = makeCtx('B')
    installBridgeRouter(a.ctx)
    installBridgeRouter(b.ctx)

    // native-host architecture: the simulator is a WebContentsView attached to
    // the window's contentView, nested one level below the root view.
    const viewWc = fakeWc()
    b.contentView.children.push({ children: [{ children: [], webContents: viewWc }] })
    await expect(invokeSpawn(viewWc)).rejects.toThrow('spawn-probe:B')
    expect(a.projectPath).not.toHaveBeenCalled()

    // The router installed FIRST must still get its own window's view traffic.
    const viewWcA = fakeWc()
    a.contentView.children.push({ children: [{ children: [], webContents: viewWcA }] })
    await expect(invokeSpawn(viewWcA)).rejects.toThrow('spawn-probe:A')

    // A `<webview>` guest nested inside that WebContentsView resolves the same way.
    const nestedGuest = fakeWc(viewWc)
    await expect(invokeSpawn(nestedGuest)).rejects.toThrow('spawn-probe:B')
    expect(a.projectPath).toHaveBeenCalledTimes(1)
  })

  it('keeps the surviving router serving after the other one is disposed', async () => {
    const a = makeCtx('A')
    const b = makeCtx('B')
    installBridgeRouter(a.ctx)
    installBridgeRouter(b.ctx)

    await a.registry.dispose()
    expect(electronStubs.handlers.has(C.SPAWN)).toBe(true)
    await expect(invokeSpawn(fakeWc(b.windowWc))).rejects.toThrow('spawn-probe:B')

    await b.registry.dispose()
    expect(electronStubs.handlers.has(C.SPAWN)).toBe(false)
    expect(electronStubs.handlers.has(C.PAGE_OPEN)).toBe(false)
    expect(electronStubs.handlers.has(C.SIMULATOR_API)).toBe(false)
  })

  it('answers SIMULATOR_API from the router owning the sender', async () => {
    const a = makeCtx('A')
    const b = makeCtx('B')
    installBridgeRouter(a.ctx)
    installBridgeRouter(b.ctx)

    const handler = electronStubs.handlers.get(C.SIMULATOR_API)!
    await handler({ sender: fakeWc(a.windowWc) }, { name: 'x', params: {} })
    expect(a.ctx.simulatorApis.invoke).toHaveBeenCalledTimes(1)
    expect(b.ctx.simulatorApis.invoke).not.toHaveBeenCalled()
  })

  it('falls back to the newest router for a sender no window hosts', async () => {
    const a = makeCtx('A')
    const b = makeCtx('B')
    installBridgeRouter(a.ctx)
    installBridgeRouter(b.ctx)

    await expect(invokeSpawn(fakeWc())).rejects.toThrow('spawn-probe:B')
    expect(a.projectPath).not.toHaveBeenCalled()
  })

  it('answers the NATIVE_HOST_ENABLED sync query from the sender own router', () => {
    const a = makeCtx('A')
    const b = makeCtx('B')
    installBridgeRouter(a.ctx)
    installBridgeRouter(b.ctx)

    const deviceA = { name: 'device-A' } as unknown as NativeDeviceInfo
    const deviceB = { name: 'device-B' } as unknown as NativeDeviceInfo
    a.ctx.bridge!.setDevice(deviceA)
    b.ctx.bridge!.setDevice(deviceB)

    const event = { sender: fakeWc(a.windowWc), returnValue: undefined as unknown }
    electronStubs.sync.emit(C.NATIVE_HOST_ENABLED, event)
    expect((event.returnValue as NativeHostConfig).device).toBe(deviceA)
  })
})

describe('dmb-resource protocol across several workbench windows', () => {
  const dmbHandlers = () =>
    electronStubs.protocolStub.handle.mock.calls.filter(([scheme]) => scheme === 'dmb-resource')

  it('installs one process-wide handler no matter how many routers exist', () => {
    installBridgeRouter(makeCtx('A').ctx)
    installBridgeRouter(makeCtx('B').ctx)

    expect(dmbHandlers()).toHaveLength(1)
    expect(electronStubs.protocolStub.installed.has('dmb-resource')).toBe(true)
    const shared = electronStubs.sessions.get(SHARED_MINIAPP_PARTITION)!
    expect(shared.protocol.installed.has('dmb-resource')).toBe(true)
  })

  it('keeps serving the first window after the second one closes', async () => {
    makeCtx('A')
    const b = makeCtx('B')
    installBridgeRouter(openCtxs[0]!.ctx)
    installBridgeRouter(b.ctx)

    await b.registry.dispose()

    // The surviving window's guests still resolve `dmb-resource://…`, and they
    // resolve against THEIR router (own sdkRoot, own session ledger).
    const handler = electronStubs.protocolStub.installed.get('dmb-resource')
    expect(handler).toBeTypeOf('function')
    await handler!({ url: 'dmb-resource://bridge-a/appA/main/pages/index/index.js' })
    expect(dmbResourceSpy).toHaveBeenCalledTimes(1)
    expect(dmbResourceSpy.mock.calls[0]![0]).toMatchObject({ sdkRoot: '/runtime/A' })
  })

  it('unhandles the scheme only when the last router is gone', async () => {
    const a = makeCtx('A')
    const b = makeCtx('B')
    installBridgeRouter(a.ctx)
    installBridgeRouter(b.ctx)
    const shared = electronStubs.sessions.get(SHARED_MINIAPP_PARTITION)!

    await b.registry.dispose()
    expect(electronStubs.protocolStub.installed.has('dmb-resource')).toBe(true)
    expect(shared.protocol.installed.has('dmb-resource')).toBe(true)

    await a.registry.dispose()
    expect(electronStubs.protocolStub.installed.has('dmb-resource')).toBe(false)
    expect(shared.protocol.installed.has('dmb-resource')).toBe(false)
  })
})

describe('routerOwnsSender', () => {
  const emptyLedger = () => ({
    serviceWcIdToAppSessionId: new Map<number, string>(),
    simulatorWcIdToAppSessionIds: new Map<number, Set<string>>(),
    wcIdToBridgeId: new Map<number, string>(),
  })
  const window = (wc: FakeWc, contentView: FakeView = { children: [] }) => ({
    webContents: wc,
    contentView,
    isDestroyed: () => false,
  }) as unknown as Parameters<typeof routerOwnsSender>[1]

  it('claims the hidden service-host window through the session ledger', () => {
    const ledger = emptyLedger()
    const serviceWc = fakeWc()
    ledger.serviceWcIdToAppSessionId.set(serviceWc.id, 'session-1')
    // The service host is a standalone BrowserWindow: no workbench window hosts
    // it, so only the ledger can attribute it.
    const owns = routerOwnsSender(ledger, window(fakeWc()), serviceWc as never)
    expect(owns).toBe(true)
  })

  it('claims a render guest through the bridge ledger', () => {
    const ledger = emptyLedger()
    const renderWc = fakeWc()
    ledger.wcIdToBridgeId.set(renderWc.id, 'bridge-1')
    expect(routerOwnsSender(ledger, window(fakeWc()), renderWc as never)).toBe(true)
  })

  it('refuses a sender that is neither in the ledger nor in the window', () => {
    expect(routerOwnsSender(emptyLedger(), window(fakeWc()), fakeWc() as never)).toBe(false)
  })

  it('refuses a destroyed sender', () => {
    const wc = { ...fakeWc(), isDestroyed: () => true }
    const ledger = emptyLedger()
    ledger.wcIdToBridgeId.set(wc.id, 'bridge-1')
    expect(routerOwnsSender(ledger, window(fakeWc()), wc as never)).toBe(false)
  })
})
