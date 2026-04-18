import { app, BrowserWindow, View, WebContentsView, globalShortcut, session } from 'electron'
import { getSimulatorServicewechatReferer } from '../../services/simulator/referer.js'
import { themeBg } from '../../utils/theme.js'

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
    headers['access-control-allow-origin'] = ['*']
    headers['access-control-allow-headers'] = ['*']
    headers['access-control-allow-methods'] = ['*']
    headers['Cross-Origin-Opener-Policy'] = ['same-origin']
    headers['Cross-Origin-Embedder-Policy'] = ['require-corp']
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
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
    },
  })

  mainWindow.once('ready-to-show', () => {
    if (process.env.NODE_ENV === 'test') {
      mainWindow.showInactive()
    } else {
      mainWindow.show()
      if (!app.isPackaged) {
        mainWindow.webContents.openDevTools({ mode: 'detach' })
      }
    }
  })

  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences) => {
    webPreferences.contextIsolation = false
  })

  mainWindow.loadFile(opts.indexHtml)

  const container = new View()
  const mainWebView = mainWindow.contentView as WebContentsView
  container.addChildView(mainWebView)
  mainWindow.contentView = container

  globalShortcut.register('CommandOrControl+Shift+I', () => {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  })

  return mainWindow
}
