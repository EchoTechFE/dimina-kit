import type { WebContents } from 'electron'
import type { PlacementReconciler } from './placement-reconciler.js'
import { createManagedWebContentsView } from './managed-web-contents-view.js'
import type {
  HostSlotMessageSubscription,
  HostSlotPortChannel,
} from './host-slot-port-channel.js'

export type HostSlotExtentMode = 'auto' | { fixed: number }

/**
 * The control surface a downstream host uses to own a persistent, single-axis
 * slot's WebContentsView (host-toolbar, host-sidebar). Axis-neutral base for
 * `HostToolbarControl`/`HostSidebarControl`, which each derive from it via
 * `Omit<HostSlotControl, 'setExtentMode'>` and rename that one member to the
 * axis-specific `setHeightMode`/`setWidthMode` — see either for the frozen,
 * per-slot public surface these members ship under.
 */
export interface HostSlotControl {
  /** Load a URL into the slot's view (lazy-creates the view). */
  loadURL(url: string): Promise<void>
  /** Load a local file into the slot's view (lazy-creates the view). */
  loadFile(filePath: string): Promise<void>
  /** The slot's live WebContents, or null if not yet created/destroyed. */
  readonly webContents: WebContents | null
  /** Remove the slot's view from the contentView and reset it (kept alive). */
  hide(): void
  /**
   * The HOST's own `webPreferences.preload` for the slot's view (purely
   * additive). The framework's advertiser runtime does NOT ride
   * `webPreferences.preload` — it is session-resident (registered on
   * `session.defaultSession`, self-guarded by the slot's own marker +
   * `isMainFrame`), so a host preload set here coexists with it and never
   * replaces it. Must be set before the view is (re)created (first
   * `loadURL`/`loadFile`, or the next one after the host closed the
   * webContents); `null` (default) means "no host preload" — it does not and
   * cannot restore any built-in preload.
   */
  setPreloadPath(path: string | null): void
  setExtentMode(mode: HostSlotExtentMode): void
  /**
   * Register a host-side handler for messages the slot PAGE sends over its
   * gated port channel. May be called before the view exists and survives
   * page reloads / wc rebuilds (each per-load MessagePort handshake
   * re-attaches the registry to the new port). Throws on an empty /
   * non-string channel. `dispose()` detaches (idempotent).
   */
  onMessage(
    channel: string,
    handler: (payload: unknown) => void,
  ): HostSlotMessageSubscription
  /**
   * Observe handshake readiness — the push counterpart to polling `send()`
   * for `true`. Fires the handler once per load generation, exactly when
   * that load's MessagePort handshake completes; registering while the
   * channel is ALREADY ready fires once asynchronously on a microtask
   * (missed-signal race guard, re-validated at fire time). A reload /
   * re-handshake fires registered handlers again; a host-initiated
   * `loadURL`/`loadFile` invalidates readiness at initiation, so handlers
   * registered in that window wait for the NEW document's handshake.
   * `dispose()` detaches (idempotent); `disposeAll` sweeps everything.
   */
  onReady(handler: () => void): HostSlotMessageSubscription
  /**
   * Post `{ channel, payload }` to the slot page (received via the page's
   * `onMessage(channel, handler)`). Gated and non-queueing: returns false —
   * delivering nothing, creating no view — while there is no live slot
   * webContents, the current load's MessagePort handshake hasn't completed,
   * or a document-replacing navigation is in flight (`loadURL`/`loadFile`
   * was issued, or the page itself started a main-frame cross-document
   * navigation, and the new document hasn't handshaked yet); true once the
   * envelope went out. No manual webContentsId gating needed: the false/true
   * result IS the readiness signal.
   */
  send(channel: string, payload: unknown): boolean
}

/**
 * Build an axis-specific control surface (`HostToolbarControl`/
 * `HostSidebarControl`) from `createHostSlotView`'s underlying `slot.control`
 * plus that one axis's renamed extent-mode setter. Forwards every shared
 * member explicitly (not a shallow spread) so the `webContents` accessor
 * stays a LIVE getter into `base` rather than a one-time snapshot.
 */
export function deriveSlotControl<Extra extends Record<string, unknown>>(
  base: HostSlotControl,
  extra: Extra,
): Omit<HostSlotControl, 'setExtentMode'> & Extra {
  return {
    loadURL: (url) => base.loadURL(url),
    loadFile: (filePath) => base.loadFile(filePath),
    get webContents(): WebContents | null {
      return base.webContents
    },
    hide: () => base.hide(),
    setPreloadPath: (path) => base.setPreloadPath(path),
    onMessage: (channel, handler) => base.onMessage(channel, handler),
    onReady: (handler) => base.onReady(handler),
    send: (channel, payload) => base.send(channel, payload),
    ...extra,
  }
}

export interface HostSlotView {
  readonly control: HostSlotControl
  setExtent(extent: number): void
  getExtent(): number
  getWebContentsId(): number | null
  dispose(): void
}

export interface HostSlotConfig {
  viewId: string
  layer: number
  marker: string
  sessionRuntime: { acquire(): void; release(): void }
  portChannel: HostSlotPortChannel
  /** Prefix for the `setExtentMode` fixed-value validation error, e.g. `'hostToolbar.setHeightMode'`. */
  setExtentModeErrorLabel: string
}

/**
 * Shared implementation behind the persistent, single-axis host slots
 * (host-toolbar, host-sidebar): lazily-created `WebContentsView` + ref-counted
 * session runtime + per-load port-channel handshake + `setBaseDesired`
 * placement, with an auto/fixed extent mode reported back through
 * `deps.onExtentChanged`. See `host-toolbar-view.ts` for the frozen
 * toolbar-shaped public wrapper.
 */
export function createHostSlotView(
  reconciler: PlacementReconciler,
  config: HostSlotConfig,
  deps: {
    onExtentChanged(extent: number): void
    reapplyPresentOverlays?(): void
  },
): HostSlotView {
  let extentMode: HostSlotExtentMode = 'auto'
  let lastExtent = 0
  // The real current size the advertiser last reported, independent of
  // `extentMode` — tracked separately from `lastExtent` (the last value we
  // actually NOTIFIED) because `setExtent` still no-ops while fixed. Needed
  // to reapply the true current size immediately when switching back to
  // 'auto': the advertiser (measure-loop.ts) dedupes against its own last-
  // EMITTED value, so if content stayed exactly the size it was before the
  // switch to fixed, it will never re-report that value on its own.
  let lastAdvertisedExtent: number | null = null
  const port = config.portChannel
  const managed = createManagedWebContentsView({
    reconciler,
    viewId: config.viewId,
    marker: config.marker,
    sessionRuntime: config.sessionRuntime,
    port,
  })

  function notifyExtent(extent: number): void {
    lastExtent = extent
    deps.onExtentChanged(extent)
    deps.reapplyPresentOverlays?.()
  }

  function setExtent(extent: number): void {
    lastAdvertisedExtent = extent
    if (extentMode !== 'auto') return
    // Push the reserved extent back to the main-window renderer so its
    // placeholder div resizes (closing the dynamic-size loop). The notified
    // extent IS retained in main (`getExtent`) so a renderer that mounts
    // later can pull/replay it; the renderer placeholder remains the
    // geometry authority — the forward anchor re-reports bounds from it.
    notifyExtent(extent)
  }

  function hideView(): void {
    reconciler.setBaseDesired(config.viewId, {
      viewId: config.viewId,
      placement: { visible: false },
      layer: config.layer,
    })
    reconciler.reconcileNow()
    // Collapse the renderer placeholder to 0 too. Otherwise its anchor keeps a
    // non-zero reserved extent and re-publishes bounds on the next window
    // resize, silently re-adding the view we just hid (unstable hide). Zeroing
    // the extent flips the anchor to `present:false` so it stops re-publishing.
    // Through the funnel so the retained value follows to 0 — a renderer
    // mounting after the hide must replay 0, not the stale pre-hide extent.
    notifyExtent(0)
    // Also clear the advertised-size memory: a hidden strip's pre-hide size is
    // stale content state, not a value a later `setExtentMode('auto')` should
    // resurrect (see the `lastAdvertisedExtent`-reapply branch below) — the
    // advertiser (still mounted, unaware of the hide) reports the real size
    // again on its own once content changes, or immediately on next mount.
    lastAdvertisedExtent = null
  }

  const control: HostSlotControl = {
    loadURL: (url) => managed.loadURL(url),
    loadFile: (filePath) => managed.loadFile(filePath),
    get webContents(): WebContents | null {
      return managed.liveWebContents()
    },
    hide(): void {
      hideView()
    },
    setPreloadPath: (path) => managed.setPreloadPath(path),
    setExtentMode(mode: HostSlotExtentMode): void {
      // Validate BEFORE touching any state: a poisoned `{ fixed }` (NaN /
      // ±Infinity / negative) must neither reach the renderer placeholder
      // (`extent: NaNpx` corrupts the strip with no error anywhere) nor
      // clobber the standing mode — fail-closed, not fail-corrupt.
      if (mode !== 'auto' && !(Number.isFinite(mode.fixed) && mode.fixed >= 0)) {
        throw new TypeError(
          `${config.setExtentModeErrorLabel}: fixed extent must be a finite, non-negative number (got ${mode.fixed})`,
        )
      }
      extentMode = mode
      if (mode !== 'auto') {
        // Pin immediately: a preload-less/static slot never advertises, so
        // waiting for the next report would leave the strip at extent 0.
        notifyExtent(mode.fixed)
      } else if (lastAdvertisedExtent !== null && lastAdvertisedExtent !== lastExtent) {
        // Reapply the real current advertised size immediately rather than
        // waiting for the next report — see `lastAdvertisedExtent`'s
        // doc-comment above for why that report may never come. No-op when
        // nothing has ever been advertised, or the advertised value already
        // matches what's notified (avoids a spurious flash/duplicate push).
        notifyExtent(lastAdvertisedExtent)
      }
    },
    onMessage(channel, handler) {
      return port.onMessage(channel, handler)
    },
    onReady(handler) {
      return port.onReady(handler)
    },
    send(channel, payload): boolean {
      return port.send(channel, payload)
    },
  }

  reconciler.registerView(config.viewId, {
    getView: () => managed.getView(),
    ensureView: () => managed.ensureView(),
    ensureLazy: (desired) => {
      if (desired?.placement.visible && !managed.liveWebContents()) managed.ensureView()
    },
  })

  return {
    control,
    setExtent,
    getExtent: () => lastExtent,
    getWebContentsId: () => managed.liveWebContents()?.id ?? null,
    dispose: () => managed.dispose(),
  }
}
