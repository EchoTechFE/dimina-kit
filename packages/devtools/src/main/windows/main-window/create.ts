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
   * Query string appended to the loaded `file://` URL. This is how a window
   * receives its own bootstrap identity (the workbench window reads the project
   * it belongs to from here), so the renderer entry knows what to mount without
   * a round-trip. Survives navigation-hardening: that check matches on the
   * `file://` prefix only and ignores the query (see navigation-hardening.ts).
   */
  query?: Record<string, string>
  /**
   * Auto-show the window on `ready-to-show` in non-test envs. Defaults to
   * `true`. `false` lets a login-gating host keep the window hidden and call
   * `show()` itself. The test env always uses `showInactive()` regardless.
   */
  autoShow?: boolean
}

/**
 * Shows `win` the way the current env expects: `showInactive()` in test env
 * so e2e windows don't steal focus, `show()` otherwise. Shared by this
 * module's own `ready-to-show` handler and by the workbench window manager's
 * reveal-after-hook-and-paint gate (`workbench-window.ts`), so the two reveal
 * paths can never pick different show methods.
 */
export function revealMainWindow(win: BrowserWindow): void {
  if (process.env.NODE_ENV === 'test') win.showInactive()
  else win.show()
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
    const isTest = process.env.NODE_ENV === 'test'
    // Visibility is governed by `autoShow` in BOTH envs. A login-gating host
    // opts out via `autoShow: false` and reveals the window itself once auth
    // passes — don't flash an un-authed window. The framework must never
    // force-show when the host opted out, in test env either (that would
    // fight the host's own reveal handler).
    if (opts.autoShow !== false) revealMainWindow(mainWindow)
    // Don't auto-open a detached DevTools for the devtools UI shell itself —
    // it's noise for normal use (the mini-app's Console lives in the embedded
    // right-panel DevTools, not here). Opt in via env for debugging the shell.
    if (!isTest && !app.isPackaged && process.env.DIMINA_DEVTOOLS_MAIN_INSPECTOR === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  })

  const rendererDir = path.dirname(opts.indexHtml)

  // Restrict the main renderer to file:// URLs under the renderer bundle and
  // route every popup through the OS browser. See navigation-hardening.ts.
  applyNavigationHardening(mainWindow.webContents, rendererDir)

  mainWindow.loadFile(opts.indexHtml, opts.query ? { query: opts.query } : undefined)

  const container = new View()
  const mainWebView = mainWindow.contentView as WebContentsView
  container.addChildView(mainWebView)
  mainWindow.contentView = container

  return mainWindow
}
