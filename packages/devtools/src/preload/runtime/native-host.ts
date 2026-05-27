import { ipcRenderer } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type {
  ApiResponsePayload,
  DisposePayload,
  NavCallbackPayload,
  PageClosePayload,
  PageLifecyclePayload,
  PageOpenRequest,
  PageOpenResult,
  SpawnRequest,
  SpawnResult,
} from '../../shared/bridge-channels.js'
import { exposeOnMainWorld } from '../shared/expose.js'

export interface RenderHostUrlOptions {
  bridgeId: string
  appId: string
  pagePath: string
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
  createRenderHostUrl(opts: RenderHostUrlOptions): string
  renderPreloadUrl: string
}

function devtoolsRoot(): string {
  return path.resolve(__dirname, '../../..')
}

function renderHostHtmlPath(): string {
  return path.join(devtoolsRoot(), 'dist/render-host/pageFrame.html')
}

function renderHostPreloadPath(): string {
  return path.join(devtoolsRoot(), 'dist/render-host/preload.cjs')
}

function buildBridge(): DiminaNativeHostBridge {
  const renderPreloadUrl = pathToFileURL(renderHostPreloadPath()).toString()

  return {
    enabled: process.env.DIMINA_NATIVE_HOST === '1',
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
    createRenderHostUrl(opts) {
      const url = new URL(pathToFileURL(renderHostHtmlPath()).toString())
      url.searchParams.set('bridgeId', opts.bridgeId)
      url.searchParams.set('appId', opts.appId)
      url.searchParams.set('pagePath', opts.pagePath)
      return url.toString()
    },
    renderPreloadUrl,
  }
}

export function installNativeHostBridge(): () => void {
  return exposeOnMainWorld('__diminaNativeHost', buildBridge())
}
