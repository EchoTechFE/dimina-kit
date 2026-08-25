import type { WebContents } from 'electron'
import { HOST_DIALOG_RUNTIME_MARKER } from '../../../shared/constants.js'
import { VIEW_ID, VIEW_LAYER } from '../../../shared/view-ids.js'
import {
  acquireHostDialogSessionRuntime,
  releaseHostDialogSessionRuntime,
} from './host-dialog-session-runtime.js'
import { createHostDialogPortChannel } from './host-dialog-port-channel.js'
import { createManagedWebContentsView } from './managed-web-contents-view.js'
import type { PlacementReconciler } from './placement-reconciler.js'
import type { ViewManagerContext } from './view-manager.js'
import type { HostDialogMessageSubscription } from './host-dialog-port-channel.js'

export type HostDialogAxis = 'block' | 'inline'

/**
 * The control object the downstream host uses to own the dialog
 * WebContentsView. Unlike `HostToolbarControl` / `HostSidebarControl`
 * (persistent strips), the dialog is a by-demand overlay: no extent-mode
 * setter (it always self-sizes from its own reverse advertiser, with a
 * conservative default while unmeasured — see below) and an explicit
 * `show()`/`hide()`/`isVisible()` surface instead of always being present
 * once loaded.
 */
export interface HostDialogControl {
  /** Load a URL into the dialog view (lazy-creates the view). */
  loadURL(url: string): Promise<void>
  /** Load a local file into the dialog view (lazy-creates the view). */
  loadFile(path: string): Promise<void>
  /** The dialog view's live WebContents, or null if not yet created/destroyed. */
  readonly webContents: WebContents | null
  /** Same contract as `HostToolbarControl.setPreloadPath`. */
  setPreloadPath(path: string | null): void
  /**
   * Register a host-side handler for messages the dialog PAGE sends via
   * `window.diminaHostDialog.send(channel, payload)`. Same contract as
   * `HostToolbarControl.onMessage`.
   */
  onMessage(
    channel: string,
    handler: (payload: unknown) => void,
  ): HostDialogMessageSubscription
  /** Same contract as `HostToolbarControl.onReady`. */
  onReady(handler: () => void): HostDialogMessageSubscription
  /** Same contract as `HostToolbarControl.send`. */
  send(channel: string, payload: unknown): boolean
  /**
   * Show the dialog, centered in the main window using its self-advertised
   * size on both axes (a conservative default for any axis not yet
   * measured). Creates the view's placement if needed; does not (re)load
   * content — the host must `loadURL`/`loadFile` first. Idempotent while
   * already visible (re-centers with the latest measured extent instead of
   * no-op, in case a resize happened while hidden).
   */
  show(): void
  /** Hide the dialog (kept alive, content preserved) without destroying the view. */
  hide(): void
  /** Whether the dialog is currently shown. */
  isVisible(): boolean
}

// Shown immediately on `show()` for whichever axis hasn't been measured yet.
// The dialog is a by-demand overlay — there is no renderer placeholder to
// pre-report intrinsic size the way the toolbar/sidebar's forward anchor
// does, so the first show of a not-yet-measured axis has nothing to center
// against. Waiting/polling for the report would mask the async race (banned
// by this repo's timing rules); a conservative default plus a re-center the
// moment `reportMeasuredExtent` lands is the fail-safe alternative.
const DEFAULT_WIDTH = 480
const DEFAULT_HEIGHT = 320

/**
 * The host-dialog slice of `ViewManager`'s public surface, split into its
 * own file for the same file-length reason as sidebar's
 * `HostSidebarViewManagerMembers` — a by-demand, dual-axis, main-centered
 * overlay rather than a persistent strip.
 */
export interface HostDialogViewManagerMembers {
  /** Return the webContents ID of the host-dialog overlay if alive, else null. */
  getHostDialogWebContentsId(): number | null
  /** Reverse size-advertiser sink for either axis; re-centers while visible. */
  reportHostDialogMeasuredExtent(axis: HostDialogAxis, extent: number): void
  /** Host-facing control surface for the dialog WebContentsView. */
  readonly hostDialog: HostDialogControl
}

export interface HostDialogView {
  readonly control: HostDialogControl
  /**
   * Reverse size-advertiser sink for either axis. While visible, immediately
   * re-centers with the newly measured extent; while hidden, just retains it
   * for the next `show()`. Non-finite / non-positive reports are dropped —
   * same fail-closed posture as the base slots' extent validation.
   */
  reportMeasuredExtent(axis: HostDialogAxis, extent: number): void
  getHostDialogWebContentsId(): number | null
  /**
   * Re-center in the main window's CURRENT content rect, e.g. after a
   * main-window resize. No-op while hidden — the next `show()` computes
   * fresh bounds anyway, so there is nothing to reapply.
   */
  reposition(): void
  dispose(): void
}

/**
 * Host-dialog factory — its PLACEMENT is deliberately NOT built on
 * `createHostSlotView`. That factory models a persistent, single-axis,
 * renderer-anchored strip (`setBaseDesired`); the dialog is a by-demand,
 * dual-axis, main-centered overlay (`setOverlayDesired` /
 * `deleteOverlayDesired`), closer in shape to the settings/popover/tooltip
 * overlays in `overlay-panels-view.ts` than to the toolbar/sidebar. It still
 * doesn't reuse `createOverlayPanel` from that file: those panels load a
 * FIXED renderer-dir entry and push typed data, whereas the dialog loads
 * ARBITRARY host content and needs the toolbar/sidebar's `loadURL`/`loadFile`
 * + gated port-channel surface. The underlying WebContentsView lazy-create /
 * liveness / load / teardown lifecycle IS shared with the base slots though
 * — see `managed-web-contents-view.ts`.
 */
export function createHostDialogView(
  ctx: ViewManagerContext,
  reconciler: PlacementReconciler,
): HostDialogView {
  const port = createHostDialogPortChannel({
    isCurrent: (wc) => managed.liveWebContents()?.id === wc.id,
  })

  const managed = createManagedWebContentsView({
    reconciler,
    viewId: VIEW_ID.hostDialog,
    marker: HOST_DIALOG_RUNTIME_MARKER,
    sessionRuntime: {
      acquire: acquireHostDialogSessionRuntime,
      release: releaseHostDialogSessionRuntime,
    },
    port,
  })

  let visible = false
  let width = DEFAULT_WIDTH
  let height = DEFAULT_HEIGHT

  function computeBounds(): { x: number; y: number; width: number; height: number } {
    const [winW = 0, winH = 0] = ctx.windows.mainWindow.getContentSize()
    // Clamp to the window so a dialog whose advertised/default size exceeds
    // the current content area still gets valid non-negative bounds instead
    // of spilling off-window or going negative.
    const w = Math.min(width, Math.max(1, winW))
    const h = Math.min(height, Math.max(1, winH))
    return {
      x: Math.max(0, Math.round((winW - w) / 2)),
      y: Math.max(0, Math.round((winH - h) / 2)),
      width: w,
      height: h,
    }
  }

  function present(): void {
    reconciler.setOverlayDesired(VIEW_ID.hostDialog, {
      viewId: VIEW_ID.hostDialog,
      placement: { visible: true, bounds: computeBounds() },
      layer: VIEW_LAYER.hostDialog,
    })
    reconciler.reconcileNow()
  }

  function reportMeasuredExtent(axis: HostDialogAxis, extent: number): void {
    if (!Number.isFinite(extent) || extent <= 0) return
    if (axis === 'inline') {
      width = extent
    } else {
      height = extent
    }
    if (visible) present()
  }

  // The host swaps content into the SAME dialog view via loadURL/loadFile
  // (e.g. re-purposing one dialog for a different prompt) — width/height are
  // this factory's own closure state, seeded once from the DEFAULT_*
  // constants and only ever mutated by reportMeasuredExtent, so without a
  // reset here a fresh, unmeasured document would inherit the PREVIOUS
  // document's size until it happens to report its own.
  function resetMeasuredExtent(): void {
    width = DEFAULT_WIDTH
    height = DEFAULT_HEIGHT
  }

  const control: HostDialogControl = {
    loadURL: (url) => {
      resetMeasuredExtent()
      return managed.loadURL(url)
    },
    loadFile: (filePath) => {
      resetMeasuredExtent()
      return managed.loadFile(filePath)
    },
    get webContents(): WebContents | null {
      return managed.liveWebContents()
    },
    setPreloadPath: (path) => managed.setPreloadPath(path),
    onMessage: (channel, handler) => port.onMessage(channel, handler),
    onReady: (handler) => port.onReady(handler),
    send: (channel, payload) => port.send(channel, payload),
    show(): void {
      managed.ensureView()
      visible = true
      present()
    },
    hide(): void {
      visible = false
      reconciler.deleteOverlayDesired(VIEW_ID.hostDialog)
      reconciler.reconcileNow()
    },
    isVisible: () => visible,
  }

  reconciler.registerView(VIEW_ID.hostDialog, {
    getView: () => managed.getView(),
    ensureView: () => managed.ensureView(),
  })

  return {
    control,
    reportMeasuredExtent,
    getHostDialogWebContentsId: () => managed.liveWebContents()?.id ?? null,
    reposition: () => { if (visible) present() },
    dispose: () => managed.dispose(),
  }
}
