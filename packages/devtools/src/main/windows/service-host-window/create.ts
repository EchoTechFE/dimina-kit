import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { devtoolsPackageRoot } from '../../utils/paths.js'
import type { ServiceHostSpec } from '../../services/service-host-pool/pool.js'

/** Session partition the service host shares with the simulator `<webview>`. */
export const SERVICE_HOST_PARTITION = 'persist:simulator'

/** Absolute path to the service-host preload (loaded at runtime by path). */
export const serviceHostPreloadPath = path.join(devtoolsPackageRoot, 'dist/service-host/preload.cjs')
const serviceHostHtmlPath = path.join(devtoolsPackageRoot, 'dist/service-host/service.html')

export interface ServiceHostWindowOptions {
  bridgeId: string
  appId: string
  pagePath: string
  pkgRoot: string
  resourceBaseUrl: string
  hostEnvSnapshot?: Record<string, unknown>
}

/**
 * Construct an (un-navigated) service-host BrowserWindow. Split out from
 * `createServiceHostWindow` so a pre-warm pool can build the window once and
 * navigate it per spawn (the spawn context lives in the URL — see
 * `buildServiceHostSpawnUrl`). The process-model flags here are the contract
 * the service-host preload depends on (it `require('electron')` and writes
 * globals onto the page realm).
 */
export function constructServiceHostWindow(opts: { appId?: string; partition?: string } = {}): BrowserWindow {
  return new BrowserWindow({
    width: 980,
    height: 720,
    show: false,
    title: opts.appId ? `Dimina Service Host: ${opts.appId}` : 'Dimina Service Host',
    webPreferences: {
      partition: opts.partition ?? SERVICE_HOST_PARTITION,
      nodeIntegration: false,
      contextIsolation: false,
      sandbox: false,
      preload: serviceHostPreloadPath,
      devTools: true,
    },
  })
}

/**
 * Build the file:// spawn URL carrying the per-spawn context the preload reads
 * from `location.search` at eval time (bridgeId/appId/pagePath/pkgRoot/
 * resourceBaseUrl/hostEnv).
 */
export function buildServiceHostSpawnUrl(opts: ServiceHostWindowOptions): string {
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
  return url.toString()
}

/**
 * Navigate a (constructed or pooled) service-host window to its spawn URL. The
 * preload re-evaluates on this navigation, rebuilding `__diminaSpawnContext`.
 * Returns the load promise (resolves on did-finish-load). Attaches the dev-only
 * detached-DevTools hook, matching the original behavior.
 */
export function navigateServiceHost(win: BrowserWindow, url: string): Promise<void> {
  const loaded = Promise.resolve(win.loadURL(url)).then(
    () => undefined,
    () => undefined,
  )
  if (!app.isPackaged) {
    // Recycled pooled windows get navigated repeatedly. A `once` hook that never
    // fires (the spawn was disposed before its service.html settled) stays on the
    // reused webContents and the next spawn's hook fires alongside it → DevTools
    // can open twice and stale hooks accumulate. Remove the prior hook before
    // attaching a fresh one. (Audit A6; dev-only.)
    const w = win as BrowserWindow & { __diminaDevToolsHook?: () => void }
    if (w.__diminaDevToolsHook) {
      try { win.webContents.removeListener('did-finish-load', w.__diminaDevToolsHook) } catch { /* wc gone */ }
    }
    const hook = (): void => {
      // URL-guard so a reset's about:blank load doesn't pop DevTools.
      if (!win.isDestroyed() && win.webContents.getURL().includes('service.html')) {
        win.webContents.openDevTools({ mode: 'detach' })
      }
    }
    w.__diminaDevToolsHook = hook
    win.webContents.once('did-finish-load', hook)
  }
  return loaded
}

/**
 * The spec a `ServiceHostPool` uses to pre-warm service-host windows. Keeps the
 * pooled window byte-equivalent to `constructServiceHostWindow`'s output, and
 * opts out of the reset storage-clear because the service host shares the
 * `persist:simulator` session with live projects (see ServiceHostSpec docs).
 */
export function serviceHostSpec(): ServiceHostSpec {
  return {
    partition: SERVICE_HOST_PARTITION,
    preloadPath: serviceHostPreloadPath,
    size: { width: 980, height: 720 },
    contextIsolation: false,
    sandbox: false,
    nodeIntegration: false,
    clearStorageOnReset: false,
  }
}

/**
 * Construct + navigate a fresh service-host window (the non-pool path).
 * Behavior-identical to the pre-refactor implementation.
 */
export function createServiceHostWindow(opts: ServiceHostWindowOptions): BrowserWindow {
  const win = constructServiceHostWindow({ appId: opts.appId })
  void navigateServiceHost(win, buildServiceHostSpawnUrl(opts))
  return win
}
