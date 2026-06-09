import { app, BrowserWindow, View, WebContentsView, session } from 'electron'
import path from 'path'
import { getSimulatorServicewechatReferer } from '../../services/simulator/referer.js'
import { mainPreloadPath } from '../../utils/paths.js'
import { themeBg } from '../../utils/theme.js'
import { applyNavigationHardening } from '../navigation-hardening.js'

export interface WindowOptions {
  title?: string
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
  indexHtml: string
}

let simulatorSessionConfigured = false

function configureSimulatorSession(): void {
  if (simulatorSessionConfigured) return
  simulatorSessionConfigured = true

  const simulatorSession = session.fromPartition('persist:simulator')

  simulatorSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const forcedReferer = getSimulatorServicewechatReferer()
    if (forcedReferer) {
      details.requestHeaders['Referer'] = forcedReferer
    }
    callback({ requestHeaders: details.requestHeaders })
  })

  simulatorSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders ?? {}
    // CORS for the native render/service hosts to fetch compiled app resources
    // cross-origin. (The COOP/COEP cross-origin-isolation headers were only for
    // the removed default-path SharedArrayBuffer sync Worker — dropped.)
    headers['access-control-allow-origin'] = ['*']
    headers['access-control-allow-headers'] = ['*']
    headers['access-control-allow-methods'] = ['*']
    callback({ responseHeaders: headers })
  })
}

export function createMainWindow(opts: WindowOptions): BrowserWindow {
  configureSimulatorSession()

  const mainWindow = new BrowserWindow({
    width: opts.width ?? 1280,
    height: opts.height ?? 980,
    minWidth: opts.minWidth ?? 1000,
    minHeight: opts.minHeight ?? 600,
    title: opts.title ?? 'Dimina DevTools',
    show: false,
    backgroundColor: themeBg(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // `sandbox: false` is required so the preload bundle can `require('electron')`
      // to access contextBridge/ipcRenderer. The renderer itself runs isolated.
      sandbox: false,
      preload: mainPreloadPath,
    },
  })

  mainWindow.once('ready-to-show', () => {
    if (process.env.NODE_ENV === 'test') {
      mainWindow.showInactive()
    } else {
      mainWindow.show()
      // Don't auto-open a detached DevTools for the devtools UI shell itself —
      // it's noise for normal use (the mini-app's Console lives in the embedded
      // right-panel DevTools, not here). Opt in via env for debugging the shell.
      if (!app.isPackaged && process.env.DIMINA_DEVTOOLS_MAIN_INSPECTOR === '1') {
        mainWindow.webContents.openDevTools({ mode: 'detach' })
      }
    }
  })

  const rendererDir = path.dirname(opts.indexHtml)

  // Restrict the main renderer to file:// URLs under the renderer bundle and
  // route every popup through the OS browser. See navigation-hardening.ts.
  applyNavigationHardening(mainWindow.webContents, rendererDir)

  mainWindow.loadFile(opts.indexHtml)

  const container = new View()
  const mainWebView = mainWindow.contentView as WebContentsView
  container.addChildView(mainWebView)
  mainWindow.contentView = container

  return mainWindow
}
