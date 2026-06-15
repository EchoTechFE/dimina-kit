import { ipcRenderer } from 'electron'
import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type { NativeDeviceInfo } from '../../shared/ipc-channels.js'
// (extension required: preload tsconfig is moduleResolution node16)
import type {
  ActivePagePayload,
  ApiResponsePayload,
  DisposePayload,
  NativeHostConfig,
  NavCallbackPayload,
  PageClosePayload,
  PageLifecyclePayload,
  PageOpenRequest,
  PageOpenResult,
  PageStackPayload,
  SpawnRequest,
  SpawnResult,
} from '../../shared/bridge-channels.js'
import { exposeOnMainWorld } from '../shared/expose.js'

export interface RenderHostUrlOptions {
  bridgeId: string
  appId: string
  pagePath: string
  /** Whether this page is a tabBar page. Surfaced on the URL so main can pick
   *  the bottom safe-area policy at `did-attach-webview` (services/safe-area). */
  isTab?: boolean
}

export interface DiminaNativeHostBridge {
  enabled: boolean
  spawn(opts: SpawnRequest): Promise<SpawnResult>
  dispose(bridgeId: string): void
  openPage(opts: PageOpenRequest): Promise<PageOpenResult>
  closePage(bridgeId: string): void
  notifyLifecycle(payload: PageLifecyclePayload): void
  notifyNavCallback(payload: NavCallbackPayload): void
  notifyApiResponse(payload: ApiResponsePayload): void
  /** Tell main which page is the visible top-of-stack (for panel/automation targeting). */
  notifyActivePage(payload: ActivePagePayload): void
  /** Tell main the full ordered page stack (for automation's App.getPageStack). */
  notifyPageStack(payload: PageStackPayload): void
  createRenderHostUrl(opts: RenderHostUrlOptions): string
  renderPreloadUrl: string
  /**
   * The selected device at bridge-install time, if the renderer already pushed
   * it (it does — SetDeviceInfo precedes AttachNative). DeviceShell reads this
   * as its initial device; live changes arrive via the DEVICE_CHANGE event.
   */
  device?: NativeDeviceInfo
  /**
   * Subscribe to a main→simulator event channel (SIMULATOR_EVENTS). Returns an
   * unsubscribe fn. The simulator renderer (DeviceShell) runs in the webview
   * main world with `nodeIntegration:false`, so it cannot `import 'electron'`;
   * this bridge owns the `ipcRenderer` plumbing on its behalf.
   */
  onSimulatorEvent<T = unknown>(channel: string, listener: (payload: T) => void): () => void
}

/**
 * Ask the main process (synchronously, at install time) whether native-host is
 * on and, if so, for the render-host file:// URLs. The simulator webview's
 * preload can't read the launch `process.env`, and — crucially — can't use
 * `node:path`/`node:url` to compute paths (the guest preload has no Node
 * builtins), so the main process (which has both) supplies everything here.
 */
function queryNativeHostConfig(): NativeHostConfig | null {
  try {
    const res = ipcRenderer.sendSync(C.NATIVE_HOST_ENABLED) as NativeHostConfig | undefined
    return res && res.enabled ? res : null
  } catch {
    return null
  }
}

function buildBridge(cfg: NativeHostConfig): DiminaNativeHostBridge {
  return {
    enabled: true,
    spawn(opts) {
      return ipcRenderer.invoke(C.SPAWN, opts) as Promise<SpawnResult>
    },
    dispose(bridgeId) {
      const payload: DisposePayload = { bridgeId }
      ipcRenderer.send(C.DISPOSE, payload)
    },
    openPage(opts) {
      return ipcRenderer.invoke(C.PAGE_OPEN, opts) as Promise<PageOpenResult>
    },
    closePage(bridgeId) {
      const payload: PageClosePayload = { bridgeId }
      ipcRenderer.send(C.PAGE_CLOSE, payload)
    },
    notifyLifecycle(payload) {
      ipcRenderer.send(C.PAGE_LIFECYCLE, payload)
    },
    notifyNavCallback(payload) {
      ipcRenderer.send(C.NAV_CALLBACK, payload)
    },
    notifyApiResponse(payload) {
      ipcRenderer.send(C.API_RESPONSE, payload)
    },
    notifyActivePage(payload) {
      ipcRenderer.send(C.ACTIVE_PAGE, payload)
    },
    notifyPageStack(payload) {
      ipcRenderer.send(C.PAGE_STACK, payload)
    },
    createRenderHostUrl(opts) {
      // `URL` + `URLSearchParams` are web globals — no node:url needed.
      const url = new URL(cfg.renderHostHtmlUrl)
      url.searchParams.set('bridgeId', opts.bridgeId)
      url.searchParams.set('appId', opts.appId)
      url.searchParams.set('pagePath', opts.pagePath)
      if (opts.isTab) url.searchParams.set('isTab', '1')
      return url.toString()
    },
    renderPreloadUrl: cfg.renderPreloadUrl,
    device: cfg.device,
    onSimulatorEvent(channel, listener) {
      const wrapped = (_event: unknown, payload: unknown): void => {
        ;(listener as (p: unknown) => void)(payload)
      }
      ipcRenderer.on(channel, wrapped)
      return () => ipcRenderer.removeListener(channel, wrapped)
    },
  }
}

/**
 * Install the native-host bridge on the simulator main world when native-host
 * mode is on. Self-gating: a no-op disposer is returned when it's off, so the
 * caller can install unconditionally.
 */
export function installNativeHostBridge(): () => void {
  const cfg = queryNativeHostConfig()
  if (!cfg) return () => {}
  return exposeOnMainWorld('__diminaNativeHost', buildBridge(cfg))
}
