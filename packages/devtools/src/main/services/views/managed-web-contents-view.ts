import type { WebContents } from 'electron'
import { WebContentsView } from 'electron'
import { handleWindowOpenExternal } from '../../windows/navigation-hardening.js'
import type { PlacementReconciler } from './placement-reconciler.js'
import type { HostSlotPortChannel } from './host-slot-port-channel.js'

export interface ManagedWebContentsViewOptions {
  reconciler: PlacementReconciler
  viewId: string
  /** `--dimina-host-*` marker passed as `additionalArguments`, self-guards the session-resident advertiser preload. */
  marker: string
  sessionRuntime: { acquire(): void; release(): void }
  /** The per-load handshake channel; shares this view's lazy-create/liveness/dispose lifecycle. */
  port: HostSlotPortChannel
  /**
   * Fires after a crashed/failed view has been torn down (see `ensureView`'s
   * `render-process-gone`/`did-fail-load` handling below). The base slots
   * (host-toolbar/host-sidebar) don't need this — their `ensureLazy` already
   * rebuilds a fresh view on the next reconcile pass once `liveWebContents()`
   * correctly reports the crash. host-dialog does: its on-demand placement
   * (`visible` flag, `overlayDesired`) isn't reconciler-driven the same way,
   * so without this a stale `visible: true` would resurrect a blank,
   * content-less modal on the next reposition (e.g. a window resize).
   */
  onBroken?(): void
}

/**
 * Shared lazy-create / liveness / load / teardown lifecycle for the
 * host-controllable WebContentsViews (host-toolbar, host-sidebar,
 * host-dialog): a single `WebContentsView` recreated on demand when the
 * previous one dies, backed by a ref-counted session-runtime registration and
 * the per-load port-channel attach. Placement (persistent strip vs by-demand
 * centered overlay) is layered on top by the caller — this module only owns
 * "is there a live view, and (re)create/load/tear it down when needed."
 */
export interface ManagedWebContentsView {
  loadURL(url: string): Promise<void>
  loadFile(filePath: string): Promise<void>
  liveWebContents(): WebContents | null
  /** Raw view accessor for `reconciler.registerView`'s `getView` slot (may be non-null with a destroyed webContents). */
  getView(): WebContentsView | null
  setPreloadPath(path: string | null): void
  ensureView(): WebContentsView
  dispose(): void
}

export function createManagedWebContentsView(
  opts: ManagedWebContentsViewOptions,
): ManagedWebContentsView {
  let view: WebContentsView | null = null
  let preloadOverride: string | null = null
  let runtimeAcquired = false

  function liveWebContents(): WebContents | null {
    const wc = view?.webContents as WebContents | undefined
    if (!wc || wc.isDestroyed()) return null
    return wc
  }

  // `liveWebContents()`'s `!wc.isDestroyed()` alone cannot tell "alive" from
  // "alive but broken" — a crashed renderer process or a failed main-frame
  // load leaves `webContents` non-destroyed but blank/unresponsive, so
  // without this the same dead view (still fielding clicks if it's an
  // on-screen slot) would be handed back to every future `ensureView()`
  // forever, and the host's own `webContents` getter would keep reporting it
  // as live. Guarded by `view !== current` so a listener from an already-
  // superseded instance can't tear down the CURRENT one.
  function teardown(current: WebContentsView, detail: string): void {
    if (view !== current) return
    console.error(`[${opts.viewId}] ${detail} — destroying so the next ensureView() rebuilds`)
    view = null
    opts.reconciler.destroyView(opts.viewId, current)
    opts.onBroken?.()
  }

  function ensureView(): WebContentsView {
    if (view && liveWebContents()) {
      return view
    }
    if (view) {
      opts.reconciler.destroyView(opts.viewId, view)
    }
    if (!runtimeAcquired) {
      opts.sessionRuntime.acquire()
      runtimeAcquired = true
    }
    const webPreferences: Electron.WebPreferences = {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      additionalArguments: [opts.marker],
    }
    if (preloadOverride !== null) {
      webPreferences.preload = preloadOverride
    }
    const next = new WebContentsView({ webPreferences })
    view = next
    opts.port.attach(next.webContents)
    try {
      next.setBackgroundColor('#121212')
    } catch {
      /* stub may lack it */
    }
    try {
      next.webContents.setWindowOpenHandler(({ url }) => handleWindowOpenExternal(url))
    } catch {
      /* stub may lack it */
    }
    next.webContents.on('did-fail-load', (_event, errorCode, _errorDescription, _validatedURL, isMainFrame) => {
      // -3 is ERR_ABORTED, which fires on every routine superseded navigation
      // (e.g. a fresh loadURL/loadFile cancelling this one) — not a real failure.
      if (!isMainFrame || errorCode === -3) return
      teardown(next, `did-fail-load (code ${errorCode})`)
    })
    next.webContents.on('render-process-gone', (_event, details) => {
      teardown(next, `render-process-gone (${details.reason})`)
    })
    return next
  }

  return {
    async loadURL(url: string): Promise<void> {
      const v = ensureView()
      // Invalidate SYNCHRONOUSLY at initiation, before the load is issued:
      // the current document is about to be replaced, so a same-tick send()
      // must report false instead of confirming delivery into it. The channel
      // recovers on the new document's did-finish-load handshake. (Cannot
      // rely on did-start-navigation here — that only covers page-initiated
      // navigations once the load is actually under way.)
      opts.port.invalidate()
      await v.webContents.loadURL(url)
    },
    async loadFile(filePath: string): Promise<void> {
      const v = ensureView()
      // Same initiation-invalidates contract as loadURL above.
      opts.port.invalidate()
      await v.webContents.loadFile(filePath)
    },
    liveWebContents,
    getView: () => view,
    setPreloadPath(path: string | null): void {
      // The HOST's own webPreferences.preload, applied when the view is next
      // (re)created. `null` = no host preload. The framework advertiser is
      // session-resident and unaffected either way (see ensureView).
      preloadOverride = path
    },
    ensureView,
    dispose(): void {
      // Narrow channel first: close the live MessagePort + sweep the onMessage
      // registry, so a send() racing teardown reports false instead of posting
      // into a wc that is about to be closed.
      opts.port.dispose()
      // Host-controllable slot view: removed from the contentView + its
      // WebContents closed (the host's loaded content is torn down on app exit).
      opts.reconciler.destroyView(opts.viewId, view)
      view = null
      // Release this manager's reference on the shared defaultSession
      // slot-runtime registration (only if it ever acquired one — a manager
      // that never used the slot must not drive the shared count to zero).
      // The LAST release unregisters; other coexisting managers keep theirs.
      if (runtimeAcquired) {
        opts.sessionRuntime.release()
        runtimeAcquired = false
      }
    },
  }
}
