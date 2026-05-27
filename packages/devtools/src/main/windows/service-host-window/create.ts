import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { devtoolsPackageRoot } from '../../utils/paths.js'

export interface ServiceHostWindowOptions {
  bridgeId: string
  appId: string
  pagePath: string
  pkgRoot: string
  resourceBaseUrl: string
  hostEnvSnapshot?: Record<string, unknown>
}

export function createServiceHostWindow(opts: ServiceHostWindowOptions): BrowserWindow {
  const serviceHostPreloadPath = path.join(devtoolsPackageRoot, 'dist/service-host/preload.cjs')
  const serviceHostHtmlPath = path.join(devtoolsPackageRoot, 'dist/service-host/service.html')

  const win = new BrowserWindow({
    width: 980,
    height: 720,
    show: false,
    title: `Dimina Service Host: ${opts.appId}`,
    webPreferences: {
      partition: 'persist:simulator',
      nodeIntegration: false,
      contextIsolation: false,
      sandbox: false,
      preload: serviceHostPreloadPath,
      devTools: true,
    },
  })

  const url = new URL(pathToFileURL(serviceHostHtmlPath).toString())
  url.searchParams.set('bridgeId', opts.bridgeId)
  url.searchParams.set('appId', opts.appId)
  url.searchParams.set('pagePath', opts.pagePath)
  url.searchParams.set('pkgRoot', opts.pkgRoot)
  url.searchParams.set('resourceBaseUrl', opts.resourceBaseUrl)
  if (opts.hostEnvSnapshot) {
    // Encode the resolved host-env so preload can hydrate
    // `__diminaSpawnContext.hostEnvSnapshot` before service.js loads.
    // Without this, sync-impls/system-info.ts falls back to generic defaults.
    url.searchParams.set('hostEnv', encodeURIComponent(JSON.stringify(opts.hostEnvSnapshot)))
  }
  void win.loadURL(url.toString())

  if (!app.isPackaged) {
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) {
        win.webContents.openDevTools({ mode: 'detach' })
      }
    })
  }

  return win
}
