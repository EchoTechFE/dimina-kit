import type { WebContents } from 'electron'
import { WebContentsView } from 'electron'
import path from 'path'
import { mainPreloadPath } from '../../utils/paths.js'
import { applyNavigationHardening } from '../../windows/navigation-hardening.js'
import * as layout from '../layout/index.js'
import { HEADER_H } from '../../../shared/constants.js'
import { VIEW_ID, VIEW_LAYER } from '../../../shared/view-ids.js'
import { destroyChildView } from './destroy-child-view.js'
import type { PlacementReconciler } from './placement-reconciler.js'
import type { ViewManagerContext } from './view-manager.js'

/**
 * The two main-owned overlay panels: the settings sheet (right-side panel over
 * a transparent backdrop) and the transient popover. Their bounds are
 * main-computed and published into the reconciler's `overlayDesired` (top-tier
 * layers, so a reorder keeps them above every base overlay).
 */
export interface OverlayPanelsView {
  showSettings(): Promise<void>
  hideSettings(): void
  showPopover(data: unknown): void
  hidePopover(): void
  /** Re-apply whichever of settings/popover is currently present (window resize / toolbar height change). */
  reapplyPresentOverlays(): void
  /** Re-apply the settings overlay only (the resize entry point re-applies settings, not popover). */
  applySettingsBoundsIfPresent(): void
  /** Destroy the cached settings view (aggregate simulator detach). */
  destroySettings(): void
  getSettingsWebContents(): WebContents | null
  getSettingsWebContentsId(): number | null
  getPopoverWebContentsId(): number | null
}

export function createOverlayPanelsView(
  ctx: ViewManagerContext,
  reconciler: PlacementReconciler,
  deps: {
    /** The host-toolbar strip height that offsets the overlay top edge. */
    getHostToolbarHeight(): number
  },
): OverlayPanelsView {
  let settingsView: WebContentsView | null = null
  let popoverView: WebContentsView | null = null

  function overlayHeaderHeight(): number {
    return HEADER_H + deps.getHostToolbarHeight()
  }

  // settings/popover bounds are main-computed; publish them into overlayDesired
  // and let the reconciler place them (they are top-tier layers, so a reorder
  // keeps them above every base overlay — the old raiseTopOverlays is gone).
  function applySettingsBounds(): void {
    if (!settingsView || ctx.windows.mainWindow.isDestroyed()) return
    const [w = 0, h = 0] = ctx.windows.mainWindow.getContentSize()
    reconciler.setOverlayDesired(VIEW_ID.settings, {
      viewId: VIEW_ID.settings,
      placement: {
        visible: true,
        bounds: layout.computeSettingsBounds(w, h, overlayHeaderHeight()),
      },
      layer: VIEW_LAYER.settings,
    })
    reconciler.reconcileNow()
  }

  function applyPopoverBounds(): void {
    if (!popoverView || ctx.windows.mainWindow.isDestroyed()) return
    const [w = 0, h = 0] = ctx.windows.mainWindow.getContentSize()
    reconciler.setOverlayDesired(VIEW_ID.popover, {
      viewId: VIEW_ID.popover,
      placement: {
        visible: true,
        bounds: layout.computePopoverBounds(w, h, overlayHeaderHeight()),
      },
      layer: VIEW_LAYER.popover,
    })
    reconciler.reconcileNow()
  }

  async function showSettings(): Promise<void> {
    if (!settingsView) {
      settingsView = new WebContentsView({
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: false,
          preload: mainPreloadPath,
        },
      })
      // Overlay loads mainPreloadPath, so the same navigation rules as the
      // main window apply — see navigation-hardening.ts.
      applyNavigationHardening(settingsView.webContents, ctx.rendererDir)
      // Transparent backing: the settings view now spans the whole content area
      // (computeSettingsBounds) and its renderer paints a transparent backdrop +
      // an opaque right-side panel, so the underlying editor/simulator show
      // through and a backdrop click closes the overlay (mirrors the popover).
      settingsView.setBackgroundColor('#00000000')
      await settingsView.webContents.loadFile(
        path.join(ctx.rendererDir, 'entries/settings/index.html'),
      )
    }
    applySettingsBounds()
  }

  function hideSettings(): void {
    reconciler.deleteOverlayDesired(VIEW_ID.settings)
    reconciler.reconcileNow()
  }

  function showPopover(data: unknown): void {
    hidePopover()
    const popover = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        preload: mainPreloadPath,
      },
    })
    // Popover overlay loads mainPreloadPath — same navigation rules apply.
    applyNavigationHardening(popover.webContents, ctx.rendererDir)
    popoverView = popover
    popover.setBackgroundColor('#00000000')
    applyPopoverBounds()
    popover.webContents.once('did-finish-load', () => {
      ctx.notify.popoverInit(popover, data)
    })
    popover.webContents.loadFile(
      path.join(ctx.rendererDir, 'entries/popover/index.html'),
    )
  }

  function hidePopover(): void {
    if (!popoverView) return
    reconciler.deleteOverlayDesired(VIEW_ID.popover)
    // Destroy the WCV first (removeChildView + close), THEN reconcile: the detach
    // op then finds the view already gone and does not double-removeChildView.
    destroyChildView(ctx.windows.mainWindow, popoverView)
    popoverView = null
    reconciler.reconcileNow()
    ctx.notify.popoverClosed()
  }

  function reapplyPresentOverlays(): void {
    if (reconciler.hasOverlayDesired(VIEW_ID.settings)) applySettingsBounds()
    if (reconciler.hasOverlayDesired(VIEW_ID.popover)) applyPopoverBounds()
  }

  function applySettingsBoundsIfPresent(): void {
    if (reconciler.hasOverlayDesired(VIEW_ID.settings)) applySettingsBounds()
  }

  function destroySettings(): void {
    destroyChildView(ctx.windows.mainWindow, settingsView)
    settingsView = null
  }

  reconciler.registerView(VIEW_ID.settings, { getView: () => settingsView })
  reconciler.registerView(VIEW_ID.popover, { getView: () => popoverView })

  return {
    showSettings,
    hideSettings,
    showPopover,
    hidePopover,
    reapplyPresentOverlays,
    applySettingsBoundsIfPresent,
    destroySettings,
    getSettingsWebContents: () => {
      if (!settingsView) return null
      if (settingsView.webContents.isDestroyed()) return null
      return settingsView.webContents
    },
    getSettingsWebContentsId: () => {
      if (!settingsView) return null
      if (settingsView.webContents.isDestroyed()) return null
      return settingsView.webContents.id
    },
    getPopoverWebContentsId: () => {
      if (!popoverView) return null
      if (popoverView.webContents.isDestroyed()) return null
      return popoverView.webContents.id
    },
  }
}
