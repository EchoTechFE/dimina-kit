import { app, BrowserWindow, View, WebContentsView, session, shell } from 'electron'
import path from 'path'
import { getSimulatorServicewechatReferer } from '../../services/simulator/referer.js'
import { mainPreloadPath } from '../../utils/paths.js'
import { themeBg } from '../../utils/theme.js'
import {
  applyNavigationHardening,
  handleWindowOpenExternal,
} from '../navigation-hardening.js'

export interface WindowOptions {
  title?: string
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
  indexHtml: string
  /**
   * Absolute path to the simulator preload bundle. Retained on the public
   * `createMainWindow` contract for source compatibility, but no longer consumed
   * here: under native-host (the sole runtime) every frame on the
   * `persist:simulator` session carries its OWN dedicated preload —
   *   - the simulator content WebContentsView gets the `.cjs` sibling via
   *     `webPreferences.preload` (see view-manager `attachNativeSimulator`),
   *   - the per-page render-host `<webview>` guests get `render-host/preload.cjs`
   *     (set as the `<webview preload>` attribute from `renderPreloadUrl`),
   *   - the service-host BrowserWindows get `service-host/preload.cjs`.
   * A session-level `frame` preload was the OLD default `<webview>` path's entry
   * point; that path is gone, and re-registering this bundle as a session frame
   * preload would (a) double-install the simulator instrumentation on the WCV
   * (session + webPreferences) and (b) fail to load as ESM (the `.js` bundle
   * under package `"type":"module"` throws `require is not defined`). So we do
   * NOT register it here.
   */
  simulatorPreloadPath: string
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
      // The simulator <webview> still relies on the webview tag; keep it enabled.
      webviewTag: true,
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

  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    // Pin the simulator <webview> onto `persist:simulator` so it shares storage
    // (and the session CORS/referer rules) with the rest of the session. The
    // preload itself rides on the `<webview preload>` attribute, not the session.
    // Empirically (Electron 41) `webPreferences.partition` is the field the
    // guest session actually consults; `params.partition` alone is a no-op,
    // so we write both belt-and-braces.
    ;(webPreferences as Electron.WebPreferences).partition = 'persist:simulator'
    params.partition = 'persist:simulator'

    // The simulator <webview> intentionally runs with `contextIsolation: false`
    // because the dimina runtime and the user-authored preload scripts share
    // the same JavaScript realm as the page — the mini-program SDK reaches
    // into the page's globals (e.g. AudioContext, custom registers) and
    // attaches helpers via window-level injection. Flipping isolation on
    // would break that contract.
    webPreferences.contextIsolation = false
    void event
  })

  // The simulator webview's webContents only exists once attached; wire its
  // window-open / will-navigate handlers here so popups + redirects don't
  // pivot to file:// or arbitrary origins.
  mainWindow.webContents.on('did-attach-webview', (_event, webviewWebContents) => {
    webviewWebContents.setWindowOpenHandler(({ url }) => handleWindowOpenExternal(url))
    webviewWebContents.on('will-navigate', (e, url) => {
      try {
        const u = new URL(url)
        // Allow the simulator's own host (localhost dev server) plus the
        // initial about:blank that Chromium uses before src loads.
        if (u.protocol === 'about:') return
        if ((u.protocol === 'http:' || u.protocol === 'https:') &&
            (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
          return
        }
        e.preventDefault()
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          void shell.openExternal(url)
        }
      } catch {
        e.preventDefault()
      }
    })
  })

  mainWindow.loadFile(opts.indexHtml)

  const container = new View()
  const mainWebView = mainWindow.contentView as WebContentsView
  container.addChildView(mainWebView)
  mainWindow.contentView = container

  return mainWindow
}
