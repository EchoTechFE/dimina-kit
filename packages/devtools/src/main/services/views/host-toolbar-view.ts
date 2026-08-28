import { HOST_TOOLBAR_RUNTIME_MARKER } from '../../../shared/constants.js'
import { VIEW_ID, VIEW_LAYER } from '../../../shared/view-ids.js'
import {
  acquireHostToolbarSessionRuntime,
  releaseHostToolbarSessionRuntime,
} from './host-toolbar-session-runtime.js'
import { createHostToolbarPortChannel } from './host-toolbar-port-channel.js'
import { createHostSlotView, deriveSlotControl } from './host-slot-view.js'
import type { HostSlotControl } from './host-slot-view.js'
import type { PlacementReconciler } from './placement-reconciler.js'
import type { ViewManagerContext } from './view-manager.js'

/**
 * Height mode for the host-toolbar placeholder strip. `'auto'` (default): the
 * session-resident advertiser's reports drive the height. `{ fixed }`: the
 * host pins the height; advertiser reports are ignored until `'auto'` again.
 */
export type HostToolbarHeightMode = 'auto' | { fixed: number }

/**
 * The control object the downstream host uses to own the toolbar
 * WebContentsView. Lazily backed by the view-manager's `hostToolbarView`.
 * Derives the shared members (`loadURL`, `loadFile`, `webContents`, `hide`,
 * `setPreloadPath`, `onMessage`, `onReady`, `send`) from `HostSlotControl` —
 * see that interface for their contract, generalized from
 * `window.diminaHostToolbar` to the axis-neutral "slot page" — and adds only
 * `setHeightMode` in place of the base's `setExtentMode`.
 */
export interface HostToolbarControl extends Omit<HostSlotControl, 'setExtentMode'> {
  /**
   * Pin or unpin the toolbar strip height. `{ fixed }` notifies the renderer
   * placeholder with that height immediately (so a preload-less/static toolbar
   * is visible without any advertiser report) and ignores subsequent advertiser
   * reports. `'auto'` (default) re-enables advertiser-driven height starting
   * from the NEXT report — it does not synthesize/replay a stale height.
   */
  setHeightMode(mode: HostToolbarHeightMode): void
}

export interface HostToolbarView {
  readonly control: HostToolbarControl
  setHostToolbarHeight(extent: number): void
  getHostToolbarHeight(): number
  getHostToolbarWebContentsId(): number | null
  dispose(): void
}

/**
 * Toolbar-specific instantiation of `createHostSlotView` (see that module for
 * the full lazy-create / port-channel / extent-mode contract). Kept as its own
 * named wrapper — not inlined into `view-manager.ts` — to freeze the existing
 * `HostToolbarControl`/`HostToolbarHeightMode` public surface independently of
 * the generic slot's neutral naming.
 */
export function createHostToolbarView(
  ctx: ViewManagerContext,
  reconciler: PlacementReconciler,
  deps: {
    reapplyPresentOverlays(): void
  },
): HostToolbarView {
  const port = createHostToolbarPortChannel({
    isCurrent: (wc) => slot.getWebContentsId() === wc.id,
  })

  const slot = createHostSlotView(
    reconciler,
    {
      viewId: VIEW_ID.hostToolbar,
      layer: VIEW_LAYER.hostToolbar,
      marker: HOST_TOOLBAR_RUNTIME_MARKER,
      sessionRuntime: {
        acquire: acquireHostToolbarSessionRuntime,
        release: releaseHostToolbarSessionRuntime,
      },
      portChannel: port,
      setExtentModeErrorLabel: 'hostToolbar.setHeightMode',
    },
    {
      onExtentChanged: (height) => ctx.notify.hostToolbarHeightChanged(height),
      reapplyPresentOverlays: () => deps.reapplyPresentOverlays(),
    },
  )

  const control: HostToolbarControl = deriveSlotControl(slot.control, {
    setHeightMode: (mode: HostToolbarHeightMode) => slot.control.setExtentMode(mode),
  })

  return {
    control,
    setHostToolbarHeight: (extent) => slot.setExtent(extent),
    getHostToolbarHeight: () => slot.getExtent(),
    getHostToolbarWebContentsId: () => slot.getWebContentsId(),
    dispose: () => slot.dispose(),
  }
}
