import type { BrowserWindow } from 'electron'
import type { ConnectionRegistry, DisposableRegistry } from '@dimina-kit/electron-deck/main'
import type { SyncStorageChange } from '../../shared/ipc-channels.js'
import type { SenderPolicy } from '../utils/ipc-registry.js'
import type { BridgeRouterHandle } from '../ipc/bridge-router.js'
import type { CdpSessionBroker } from '../services/cdp-session/index.js'
import type { InternalDevtoolsWindow } from '../windows/internal-devtools-window/index.js'
import type { NetworkForwarder } from '../services/network-forward/index.js'
import type { AppDataTap } from '../services/simulator-appdata/index.js'
import type { StorageApi } from '../services/simulator-storage/index.js'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'
import { resolveNativeAppDataKeys, resolveNativeStorageOverview } from './native-overview.js'
import { registerMcpWindow, noteActiveBridgeId } from '../services/mcp/index.js'
import { createRenderInspector } from '../services/render-inspect/index.js'
import { setupSimulatorStorage } from '../services/simulator-storage/index.js'
import { createNetworkForwarder } from '../services/network-forward/index.js'
import { setupSimulatorWxml } from '../services/simulator-wxml/index.js'
import { setupSimulatorAppData } from '../services/simulator-appdata/index.js'
import { setupSimulatorCurrentPage } from '../services/simulator-current-page/index.js'
import { toDisposable } from '@dimina-kit/electron-deck/main'

/**
 * Narrow view of the context fields these services read, plus the four fields
 * they publish back onto it for bridge-router to consume.
 */
export interface WindowRuntimeContext {
  registry: DisposableRegistry
  connections: ConnectionRegistry
  cdpSessionBroker: CdpSessionBroker
  senderPolicy: SenderPolicy
  workspace: WorkspaceService
  bridge?: BridgeRouterHandle
  internalDevtoolsWindow?: InternalDevtoolsWindow
  storageApi?: StorageApi
  onServiceStorageChanged?: (appId: string, change: SyncStorageChange) => void
  networkForward?: NetworkForwarder
  appData?: AppDataTap
}

/**
 * Resolve the active project's appId. Shared by the storage panel filter, the
 * native-host WXML/element-inspect services (which scope the active render
 * guest by appId) and the editor's per-project workspace identity.
 */
export function createActiveAppIdResolver(context: Pick<WindowRuntimeContext, 'workspace'>): () => string | null {
  return () => {
    const session = context.workspace.getSession()
    const appInfo = session?.appInfo as { appId?: string } | undefined
    return appInfo?.appId ?? null
  }
}

/**
 * Panel-backing services that push into one window's renderer: storage, and
 * under native-host the MCP target tracking plus the WXML / AppData /
 * current-page streams.
 */
export function setupWindowRuntimeServices(
  context: WindowRuntimeContext,
  mainWindow: BrowserWindow,
  getActiveAppId: () => string | null,
): void {
  // MCP drives whichever project window the user is in, so each window records
  // its own facts and this record dies with the window — other project windows
  // keep theirs.
  const mcpWindow = registerMcpWindow(context, {
    nativeHost: false,
    activeBridgeId: null,
    nativeOverviewProvider: null,
    getProjectPath: () => context.workspace.getProjectPath(),
    getAppId: getActiveAppId,
  })
  context.registry.add(mcpWindow.dispose)

  // Native-host: the real mini-app page runs in a nested render-host
  // <webview> guest, not the localhost:7788 shell. Point the MCP
  // `simulator` CDP target at the active render guest and keep it following
  // the visible page across navigation/tab switches. Only wired under
  // native-host so the default path stays byte-identical.
  if (context.bridge?.isNativeHost()) {
    mcpWindow.facts.nativeHost = true
    mcpWindow.facts.nativeOverviewProvider = async () => {
      const appId = getActiveAppId()
      const stack = context.bridge?.getPageStack?.(appId ?? undefined) ?? []
      const top = stack[stack.length - 1]
      const overview = {
        currentRoute: top?.pagePath ?? null,
        pageStackDepth: stack.length,
        storageKeys: [] as string[],
        storageCount: 0,
        appDataKeys: [] as string[],
      }

      if (appId) {
        const storage = await resolveNativeStorageOverview(context, appId)
        overview.storageKeys = storage.storageKeys
        overview.storageCount = storage.storageCount
        overview.appDataKeys = resolveNativeAppDataKeys(context, appId)
      }

      return overview
    }
    const off = context.bridge.onRenderEvent((ev) => noteActiveBridgeId(context, ev.bridgeId))
    context.registry.add(off)
  }

  // Native-host inspector: injects the render-guest IIFE and drives WXML /
  // element-highlight against the active render-host <webview>. Reused by
  // the storage panel (element inspect) and the WXML panel service.
  const renderInspector = createRenderInspector({ connections: context.connections, broker: context.cdpSessionBroker })

  const storage = setupSimulatorStorage(mainWindow.webContents, {
    senderPolicy: context.senderPolicy,
    connections: context.connections,
    broker: context.cdpSessionBroker,
    // Scopes simulator-webview discovery to THIS window — otherwise a second
    // project window can steal the first window's already-attached simulator
    // (see setupSimulatorStorage's `window` option doc).
    window: mainWindow,
    // Per-project filter for the simulator-storage panel: the simulator
    // uses a fixed `persist:simulator` partition + a fixed simulator.html
    // origin, so localStorage is shared across every project that has
    // ever opened. The dimina runtime isolates writes with `${appId}_`
    // prefixes; this callback lets the storage panel filter the CDP
    // snapshot/event stream to the active appId.
    getActiveAppId,
    // Native-host: route element inspection to the active render guest, and
    // read/write storage from the service-host window's file:// store.
    bridge: context.bridge,
    renderInspector,
  })
  context.registry.add(storage)
  // Native-host: expose the async-storage runtime hook so bridge-router
  // routes async wx.setStorage/etc. to the unified service-host store.
  if (storage.storageApi) {
    context.storageApi = storage.storageApi
    context.registry.add(() => { context.storageApi = undefined })
    // SYNC wx storage writes bypass main (they hit the service-host localStorage
    // directly); the service-host posts `storageChanged` and bridge-router routes
    // it here so the Storage panel stays live without a manual reload.
    context.onServiceStorageChanged = storage.onSyncStorageChange
    context.registry.add(() => { context.onServiceStorageChanged = undefined })
  }

  // Native-host WXML + AppData panels: main sources the data (WXML pulled
  // from the active render guest; AppData tapped from the service→render
  // setData stream in bridge-router) and pushes it to the renderer. Inert on
  // the default dimina-fe path (which sources both from the simulator
  // miniappSnapshot transport), so only wire them when native-host is on.
  if (context.bridge?.isNativeHost()) {
    // Native-host: surface the simulator WCV's network (wx.request/download/
    // upload run there, not in the service host) in the embedded DevTools by
    // injecting its raw Network.* CDP events into the DevTools front-end so the
    // native Network tab renders them (service-host console line is the
    // fallback). The ViewManager calls the forwarder's attachSimulator +
    // setDevtoolsHost from attachNativeSimulator once the simulator WCV +
    // DevTools host exist; getServiceWc here is the fallback sink target.
    const networkForward = createNetworkForwarder({
      getServiceWc: (appId) => context.bridge?.getServiceWc(appId) ?? null,
      getResourceServerBaseUrl: () => context.bridge?.getResourceBaseUrl?.() ?? null,
      // The simulator shell's own static-asset server (serves simulator.html
      // + its JS/CSS, independent from the resource server above — see
      // NetworkForwarderBridge.getSimulatorServerBaseUrl's doc). Host is
      // always 'localhost' — see shared/simulator-route.ts's
      // buildSimulatorUrlFromSpec default. Absent (null port) when no
      // project is open.
      getSimulatorServerBaseUrl: () => {
        const port = context.workspace?.getSession()?.port
        return typeof port === 'number' ? `http://localhost:${port}/` : null
      },
      connections: context.connections,
      broker: context.cdpSessionBroker,
    })
    context.networkForward = networkForward
    context.registry.add(networkForward)
    context.registry.add(() => { context.networkForward = undefined })
    // Global mirror: once the standalone internal
    // DevTools window builds its own front-end host, mirror the full
    // unfiltered Network stream into it. Attached AFTER context.networkForward
    // is assigned above — the callback re-reads the mutable field on every
    // fire, so ordering only matters for readability here, not correctness.
    context.registry.add(toDisposable(
      context.internalDevtoolsWindow?.onHostChanged((hostWc) => {
        context.networkForward?.setGlobalDevtoolsHost(hostWc)
      }) ?? (() => {}),
    ))

    // Main-process WebSocket traffic (wx.connectSocket runs on the Node `ws`
    // transport, invisible to any webContents debugger): bridge-router fans
    // the trace stream out here, and the forwarder synthesizes it into
    // Network.webSocket* CDP events for the same Network panel sinks.
    context.registry.add(toDisposable(
      context.bridge?.onNativeWebSocketTrace?.((ownerId, event) => {
        context.networkForward?.reportWebSocketTrace(ownerId, event)
      }) ?? (() => {}),
    ))

    context.registry.add(setupSimulatorWxml(mainWindow.webContents, {
      senderPolicy: context.senderPolicy,
      bridge: context.bridge,
      inspector: renderInspector,
      getActiveAppId,
    }))
    const appDataService = setupSimulatorAppData(mainWindow.webContents, {
      senderPolicy: context.senderPolicy,
      getActiveAppId,
      // AppData-panel edit write-back target: the service-host window owning
      // the edited page bridge.
      bridge: context.bridge,
    })
    // bridge-router feeds this via ctx.appData (service→render tap + evict).
    context.appData = appDataService
    context.registry.add(appDataService)
    context.registry.add(() => { context.appData = undefined })
    // Push the visible page route to the toolbar on every navigation (the
    // page stack lives in the DeviceShell WCV, invisible to renderer
    // <webview> nav events).
    context.registry.add(setupSimulatorCurrentPage(mainWindow.webContents, {
      bridge: context.bridge,
    }))
  }
}
