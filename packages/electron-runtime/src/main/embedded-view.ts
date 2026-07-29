import {
  ipcMain,
  shell,
  WebContentsView,
  type IpcMainEvent,
  type WebContents,
} from 'electron'
import type { RuntimeContext } from './runtime-context.js'
import {
  configureMiniappSession,
  miniappPartition,
} from './services/views/miniapp-partition.js'
import {
  handleCustomApiBridgeRequest,
  type CustomApiBridgeRequest,
} from './services/simulator/custom-apis.js'
import { runtimeSimulatorPreloadPath } from './utils/paths.js'

const CUSTOM_API_REQUEST = 'simulator:custom-apis:bridge-request'
const CUSTOM_API_RESPONSE = 'simulator:custom-apis:bridge-response'

export interface EmbeddedMiniappView {
  view: WebContentsView
  ready: Promise<void>
  dispose(): Promise<void>
}

function allowRuntimeNavigation(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'about:'
      || parsed.protocol === 'file:'
      || ((parsed.protocol === 'http:' || parsed.protocol === 'https:')
        && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'))
  } catch {
    return false
  }
}

function hardenNavigation(wc: WebContents): void {
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (event, url) => {
    if (allowRuntimeNavigation(url)) return
    event.preventDefault()
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
  })
}

export function createEmbeddedMiniappView(
  ctx: RuntimeContext,
  options: {
    appId: string
    projectPath: string
    simulatorUrl: string
  },
): EmbeddedMiniappView {
  const partition = miniappPartition(options.appId, options.projectPath)
  configureMiniappSession(partition)

  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: false,
      sandbox: false,
      webviewTag: true,
      preload: runtimeSimulatorPreloadPath,
      partition,
    },
  })
  const simulatorWc = view.webContents
  hardenNavigation(simulatorWc)

  let resolveReady: () => void
  let rejectReady: (error: unknown) => void
  let settled = false
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = () => {
      if (settled) return
      settled = true
      resolve()
    }
    rejectReady = reject
  })

  simulatorWc.on('will-attach-webview', (_event, preferences, params) => {
    ;(preferences as Electron.WebPreferences).partition = partition
    params.partition = partition
    preferences.contextIsolation = false
    ;(preferences as Electron.WebPreferences).sandbox = false
  })
  simulatorWc.on('did-attach-webview', (_event, guest) => {
    hardenNavigation(guest)
    guest.once('did-finish-load', resolveReady)
  })

  const customApiHandler = (event: IpcMainEvent, request: unknown): void => {
    if (event.sender.id !== simulatorWc.id) return
    const value = request as CustomApiBridgeRequest | undefined
    if (!value || typeof value.id !== 'number') return
    void handleCustomApiBridgeRequest(ctx.simulatorApis, value).then((response) => {
      if (!simulatorWc.isDestroyed()) simulatorWc.send(CUSTOM_API_RESPONSE, response)
    })
  }
  ipcMain.on(CUSTOM_API_REQUEST, customApiHandler)

  void simulatorWc.loadURL(options.simulatorUrl).catch((error) => {
    if (!settled) {
      settled = true
      rejectReady(error)
    }
  })

  let disposed = false
  return {
    view,
    ready,
    async dispose() {
      if (disposed) return
      disposed = true
      ipcMain.removeListener(CUSTOM_API_REQUEST, customApiHandler)
      await ctx.bridge?.disposeSessionsForSimulator?.(simulatorWc.id)
      try {
        if (!ctx.windows.mainWindow.isDestroyed()) {
          ctx.windows.mainWindow.contentView.removeChildView(view)
        }
      } catch {
        // The host may have already detached the view; disposal stays idempotent.
      }
      if (!simulatorWc.isDestroyed()) simulatorWc.close()
      resolveReady()
    },
  }
}
