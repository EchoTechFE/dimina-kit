import { app, BrowserWindow, View, WebContentsView } from 'electron'
import path from 'path'
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
  /**
   * Auto-show the window on `ready-to-show` in non-test envs. Defaults to
   * `true`. `false` lets a login-gating host keep the window hidden and call
   * `show()` itself. The test env always uses `showInactive()` regardless.
   */
  autoShow?: boolean
}

export function createMainWindow(opts: WindowOptions): BrowserWindow {
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
      // A login-gating host opts out via `autoShow: false` and shows the
      // window itself once auth passes — don't flash an un-authed window.
      if (opts.autoShow !== false) {
        mainWindow.show()
      }
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
