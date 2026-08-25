import { HOST_SIDEBAR_RUNTIME_MARKER } from '../../../shared/constants.js'
import { VIEW_ID, VIEW_LAYER } from '../../../shared/view-ids.js'
import {
  acquireHostSidebarSessionRuntime,
  releaseHostSidebarSessionRuntime,
} from './host-sidebar-session-runtime.js'
import { createHostSidebarPortChannel } from './host-sidebar-port-channel.js'
import { createHostSlotView, deriveSlotControl } from './host-slot-view.js'
import type { HostSlotControl } from './host-slot-view.js'
import type { PlacementReconciler } from './placement-reconciler.js'
import type { ViewManagerContext } from './view-manager.js'

/**
 * Width mode for the host-sidebar placeholder strip, mirroring
 * `HostToolbarHeightMode` on the inline axis.
 */
export type HostSidebarWidthMode = 'auto' | { fixed: number }

/**
 * The control object the downstream host uses to own the sidebar
 * WebContentsView. Derives the shared members from `HostSlotControl` — see
 * that interface for their contract, which carries over unchanged on the
 * inline axis — and adds only `setWidthMode` in place of the base's
 * `setExtentMode`, mirroring `HostToolbarControl.setHeightMode`.
 */
export interface HostSidebarControl extends Omit<HostSlotControl, 'setExtentMode'> {
  /**
   * Pin or unpin the sidebar strip width. Same contract as
   * `HostToolbarControl.setHeightMode` on the inline axis.
   */
  setWidthMode(mode: HostSidebarWidthMode): void
}

/**
 * The host-sidebar slice of `ViewManager`'s public surface, split into its
 * own file (mixed in via `extends`) to keep view-manager.ts under the repo's
 * file-length ratchet. Mirrors `hostToolbar`'s members on the inline axis;
 * never coexists with a height-cycle dependency on settings/popover/tooltip.
 */
export interface HostSidebarViewManagerMembers {
  /** Return the webContents ID of the host-sidebar overlay if alive, else null. */
  getHostSidebarWebContentsId(): number | null
  /** Return the last host-sidebar width NOTIFIED to the main-window renderer. */
  getHostSidebarWidth(): number
  /** Reverse size-advertiser sink for the sidebar strip's inline (width) axis. */
  setHostSidebarWidth(extent: number): void
  /** Host-facing control surface for the sidebar WebContentsView. */
  readonly hostSidebar: HostSidebarControl
}

export interface HostSidebarView {
  readonly control: HostSidebarControl
  setHostSidebarWidth(extent: number): void
  getHostSidebarWidth(): number
  getHostSidebarWebContentsId(): number | null
  dispose(): void
}

/**
 * Sidebar-specific instantiation of `createHostSlotView` (see that module for
 * the full lazy-create / port-channel / extent-mode contract). Symmetric to
 * `createHostToolbarView` on the inline (width) axis instead of block
 * (height) — the slot itself is axis-agnostic (a single advertised extent
 * number); which CSS dimension it resizes is decided entirely by the host's
 * renderer placeholder layout, not here. The sidebar never coexists with the
 * settings/popover/tooltip overlays, so unlike the toolbar there is no
 * `reapplyPresentOverlays` dependency to thread through.
 */
export function createHostSidebarView(
  ctx: ViewManagerContext,
  reconciler: PlacementReconciler,
): HostSidebarView {
  const port = createHostSidebarPortChannel({
    isCurrent: (wc) => slot.getWebContentsId() === wc.id,
  })

  const slot = createHostSlotView(
    reconciler,
    {
      viewId: VIEW_ID.hostSidebar,
      layer: VIEW_LAYER.hostSidebar,
      marker: HOST_SIDEBAR_RUNTIME_MARKER,
      sessionRuntime: {
        acquire: acquireHostSidebarSessionRuntime,
        release: releaseHostSidebarSessionRuntime,
      },
      portChannel: port,
      setExtentModeErrorLabel: 'hostSidebar.setWidthMode',
    },
    {
      onExtentChanged: (width) => ctx.notify.hostSidebarWidthChanged(width),
    },
  )

  const control: HostSidebarControl = deriveSlotControl(slot.control, {
    setWidthMode: (mode: HostSidebarWidthMode) => slot.control.setExtentMode(mode),
  })

  return {
    control,
    setHostSidebarWidth: (extent) => slot.setExtent(extent),
    getHostSidebarWidth: () => slot.getExtent(),
    getHostSidebarWebContentsId: () => slot.getWebContentsId(),
    dispose: () => slot.dispose(),
  }
}
