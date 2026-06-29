import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { devtoolsPackageRoot } from '../../utils/paths.js'
import type { ServiceHostSpec } from '../../services/service-host-pool/pool.js'
import { configureMiniappSession, miniappPartition, SHARED_MINIAPP_PARTITION } from '../../services/views/miniapp-partition.js'

/**
 * Default service-host partition when no project `appId` is supplied (the
 * pre-warm pool's shared, isolation-UNAWARE session — see `serviceHostSpec`).
 * Per-project service hosts get a `persist:miniapp-<key>` partition instead so
 * their localStorage/cookies are shared with that project's render side only.
 */
export const SERVICE_HOST_PARTITION = SHARED_MINIAPP_PARTITION

/** Absolute path to the service-host preload (loaded at runtime by path). */
export const serviceHostPreloadPath = path.join(devtoolsPackageRoot, 'dist/service-host/preload.cjs')
const serviceHostHtmlPath = path.join(devtoolsPackageRoot, 'dist/service-host/service.html')

export interface ServiceHostWindowOptions {
  bridgeId: string
  appId: string
  /** Current project root. Folded into the session partition (with appId) so a
   * different project declaring the same appId gets isolated storage. Omitted on
   * the pre-warm pool path (no project known yet → shared partition). */
  projectPath?: string
  pagePath: string
  pkgRoot: string
  root?: string
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
  const partition = opts.partition ?? SERVICE_HOST_PARTITION
  // Apply the simulator runtime's protocol handlers + webRequest policies to
  // THIS project's session before the window loads. Idempotent per partition.
  configureMiniappSession(partition)
  return new BrowserWindow({
    width: 980,
    height: 720,
    show: false,
    title: opts.appId ? `Dimina Service Host: ${opts.appId}` : 'Dimina Service Host',
    webPreferences: {
      partition,
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
  url.searchParams.set('root', opts.root || 'main')
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
  if (!app.isPackaged && process.env.NODE_ENV !== 'test') {
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
 * opts out of the reset storage-clear because the service host shares its
 * session with live projects (see ServiceHostSpec docs).
 *
 * KNOWN BLOCKER (intentional): the pre-warm pool is NOT per-project isolation
 * aware. It warms windows on ONE `defaultSpec` partition before any project is
 * known, so a pooled window cannot carry a project-derived partition — handing
 * one project's warmed window to another project would cross-contaminate
 * storage. Therefore the pool's `defaultSpec` (and pooled `acquire`) call this
 * with NO appId → the shared `persist:simulator` partition; per-project
 * isolation only applies on the default (non-pooled) `createServiceHostWindow`
 * path, which passes the project's appId. Reconciling pooling with per-project
 * partitions (e.g. per-partition sub-pools) is out of scope for this change.
 */
export function serviceHostSpec(appId?: string, projectPath?: string): ServiceHostSpec {
  return {
    // Per-project partition when an appId is known (so this project's service
    // host shares storage ONLY with its own render side); the shared partition
    // for the pre-warm pool's default spec (no appId — see KNOWN BLOCKER below).
    // projectPath joins the key so same-appId/different-path projects isolate;
    // it must match the simulator WCV's partition (view-manager passes the same
    // (appId, projectPath)).
    partition: appId ? miniappPartition(appId, projectPath) : SERVICE_HOST_PARTITION,
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
  // Default (non-pooled) path: pin the service host to THIS project's partition
  // so its logic-layer localStorage/cookies are shared with the project's render
  // side only, never with other projects.
  const win = constructServiceHostWindow({ appId: opts.appId, partition: miniappPartition(opts.appId, opts.projectPath) })
  void navigateServiceHost(win, buildServiceHostSpawnUrl(opts))
  return win
}
