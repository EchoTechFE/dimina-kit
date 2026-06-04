import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BridgeRouter } from './bridge-router.js'
import { CHANNELS } from './shared/channels.js'
import type { SpawnRequest } from './shared/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const runtimeRoot = path.resolve(__dirname, '..')

let router: BridgeRouter | undefined
let simulatorWindow: BrowserWindow | undefined

function createSimulatorWindow() {
  const preloadPath = path.join(__dirname, 'render-host', 'preload.js')
  const pageFramePath = path.join(runtimeRoot, 'src', 'render-host', 'pageFrame.html')
  const indexPath = path.join(runtimeRoot, 'dist', 'simulator-window', 'index.html')
  const indexUrl = new URL(pathToFileURL(indexPath).toString())
  indexUrl.searchParams.set('renderSrc', pathToFileURL(pageFramePath).toString())
  indexUrl.searchParams.set('renderPreload', preloadPath)

  simulatorWindow = new BrowserWindow({
    width: 800,
    height: 1200,
    show: true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
      webviewTag: true,
      devTools: true,
    },
  })

  simulatorWindow.loadURL(indexUrl.toString())
  simulatorWindow.webContents.openDevTools({ mode: 'detach' })
}

app.whenReady().then(() => {
  router = new BridgeRouter({ runtimeRoot })
  ipcMain.handle(CHANNELS.SPAWN, (event, opts: SpawnRequest) => {
    if (!router) {
      throw new Error('[native-runtime] BridgeRouter is not initialized')
    }
    return router.spawn(opts.appId, opts.bridgeId, event.sender, opts)
  })

  createSimulatorWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createSimulatorWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
