import { ipcRenderer } from 'electron'
import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type { NativeDeviceInfo } from '../../shared/ipc-channels.js'
import type { PageResizePayload } from '@dimina-kit/electron-runtime/shared/page-orientation'
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
  SessionActivePayload,
  SpawnRequest,
  SpawnResult,
} from '../../shared/bridge-channels.js'
import { buildRenderHostDocumentUrl } from '../../shared/dmb-resource-url.js'
import { exposeOnMainWorld } from '../shared/expose.js'

export interface RenderHostUrlOptions {
  bridgeId: string
  appId: string
  /** The page's resource root inside the mini-app package (e.g. `'main'`), from `SpawnResult.root`. */
  root: string
  pagePath: string
  /** Whether this page is a tabBar page. Surfaced on the URL so main can pick
   *  the bottom safe-area policy at `did-attach-webview` (services/safe-area). */
  isTab?: boolean
  /** The page's resolved `window.backgroundColor` (page ∪ app-level, already
   *  defaulted — see `pageBackgroundColor` in page-stack-controller.ts).
   *  Surfaced on the URL as `bgColor`: render-host/preload.cjs reads it and
   *  primes the guest's own document background before the page's own CSS
   *  loads. `WebContents` (the `<webview>` guest) has no `setBackgroundColor`,
   *  so main never consumes this — DeviceShell separately primes the host
   *  `<webview>` element's own CSS background from the same source. */
  backgroundColor?: string
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
  /** Tell main the visible top page's window geometry changed (PAGE_RESIZE). */
  notifyResize(payload: PageResizePayload): void
  /**
   * Tell main this app session's shell is the one on screen.
   * Soft reload mounts two shells at once, so main cannot infer visibility from who published geometry last — the shell that owns the screen declares it.
   */
  notifySessionActive(payload: SessionActivePayload): void
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
    notifyResize(payload) {
      ipcRenderer.send(C.PAGE_RESIZE, payload)
    },
    notifySessionActive(payload) {
      ipcRenderer.send(C.SESSION_ACTIVE, payload)
    },
    createRenderHostUrl(opts) {
      // Same-origin document on `dmb-resource://<bridgeId>/<appId>/<root>/<page directory>/__frame__.html`
      // (path depth tracks the page's package directory depth) so relative
      // package image paths resolve against the resource server, not file:// asar.
      return buildRenderHostDocumentUrl(opts)
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
