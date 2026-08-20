import type { WebContents } from 'electron'
import { WebContentsView } from 'electron'
import { createOverlayPanel, type OverlayPanel } from '@dimina-kit/electron-deck/main'
import { mainPreloadPath } from '../../utils/paths.js'
import { applyNavigationHardening } from '../../windows/navigation-hardening.js'
import * as layout from '../layout/index.js'
import { HEADER_H } from '../../../shared/constants.js'
import { VIEW_ID, VIEW_LAYER } from '../../../shared/view-ids.js'
import type { PlacementReconciler } from './placement-reconciler.js'
import type { ViewManagerContext } from './view-manager.js'

export interface TooltipShowPayload {
  anchor: { x: number; y: number; width: number; height: number }
  text: string
}

interface TooltipRenderPayload {
  requestId: number
  text: string
  maxWidth: number
}

/**
 * The main-owned overlay panels: the settings sheet (right-side panel over a
 * transparent backdrop), the transient compile-mode popover, and the tooltip.
 * Each is an `OverlayPanel` (`@dimina-kit/electron-deck/main`) — the shared
 * lazy-create/reuse/destroy WebContentsView lifecycle — wired into THIS
 * module's own placement reconciler (the panel factory owns no z-order/bounds
 * authority itself; see overlay-panel.ts's doc-comment). Bounds are
 * main-computed and published into the reconciler's `overlayDesired` (top-tier
 * layers, so a reorder keeps them above every base overlay).
 */
export interface OverlayPanelsView {
  showSettings(): Promise<void>
  hideSettings(): void
  showPopover(data: unknown): void
  hidePopover(): void
  prepareTooltip(): void
  showTooltip(data: TooltipShowPayload): void
  hideTooltip(): void
  markOverlayReady(webContentsId: number): void
  applyTooltipMeasurement(
    webContentsId: number,
    measurement: { requestId: number; width: number; height: number },
  ): void
  /** Re-apply whichever of settings/popover is currently present (window resize / toolbar height change). Tooltip excluded — it re-anchors on its own next show, a stale position while hidden doesn't matter. */
  reapplyPresentOverlays(): void
  /** Re-apply the settings overlay only (the resize entry point re-applies settings, not popover). */
  applySettingsBoundsIfPresent(): void
  /** Destroy the cached settings + tooltip views (aggregate simulator detach). */
  destroySettings(): void
  getSettingsWebContents(): WebContents | null
  getSettingsWebContentsId(): number | null
  getPopoverWebContentsId(): number | null
  getTooltipWebContentsId(): number | null
}

export function createOverlayPanelsView(
  ctx: ViewManagerContext,
  reconciler: PlacementReconciler,
  deps: {
    /** The host-toolbar strip height that offsets the overlay top edge. */
    getHostToolbarHeight(): number
  },
): OverlayPanelsView {
  function overlayHeaderHeight(): number {
    return HEADER_H + deps.getHostToolbarHeight()
  }

  function overlayDesiredSetter(viewId: string, layer: number) {
    return (bounds: layout.Bounds | null): void => {
      if (bounds === null) {
        reconciler.deleteOverlayDesired(viewId)
      } else {
        reconciler.setOverlayDesired(viewId, {
          viewId,
          placement: { visible: true, bounds },
          layer,
        })
      }
      reconciler.reconcileNow()
    }
  }

  const settingsPanel: OverlayPanel = createOverlayPanel({
    electron: { createWebContentsView: (opts) => new WebContentsView(opts) },
    rendererDir: ctx.rendererDir,
    entry: 'entries/settings/index.html',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: mainPreloadPath,
    },
    hardenNavigation: (wc) => applyNavigationHardening(wc, ctx.rendererDir),
    setDesired: overlayDesiredSetter(VIEW_ID.settings, VIEW_LAYER.settings),
    registerView: (getView) => reconciler.registerView(VIEW_ID.settings, { getView }),
    destroyView: (view) => reconciler.destroyView(VIEW_ID.settings, view),
    readyMode: 'manual',
  })

  const popoverPanel: OverlayPanel<unknown> = createOverlayPanel<unknown>({
    electron: { createWebContentsView: (opts) => new WebContentsView(opts) },
    rendererDir: ctx.rendererDir,
    entry: 'entries/popover/index.html',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: mainPreloadPath,
    },
    hardenNavigation: (wc) => applyNavigationHardening(wc, ctx.rendererDir),
    setDesired: overlayDesiredSetter(VIEW_ID.popover, VIEW_LAYER.popover),
    registerView: (getView) => reconciler.registerView(VIEW_ID.popover, { getView }),
    destroyView: (view) => reconciler.destroyView(VIEW_ID.popover, view),
    pushData: (view, data) => ctx.notify.popoverInit(view, data),
    readyMode: 'manual',
  })

  const tooltipPanel: OverlayPanel<TooltipRenderPayload> = createOverlayPanel<TooltipRenderPayload>({
    electron: { createWebContentsView: (opts) => new WebContentsView(opts) },
    rendererDir: ctx.rendererDir,
    entry: 'entries/tooltip/index.html',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: mainPreloadPath,
    },
    hardenNavigation: (wc) => applyNavigationHardening(wc, ctx.rendererDir),
    setDesired: overlayDesiredSetter(VIEW_ID.tooltip, VIEW_LAYER.tooltip),
    registerView: (getView) => reconciler.registerView(VIEW_ID.tooltip, { getView }),
    prepareView: (view) => {
      const [width = 0, height = 0] = ctx.windows.mainWindow.getContentSize()
      reconciler.prepareView(VIEW_ID.tooltip, view, {
        x: 0,
        y: 0,
        width: Math.max(1, width),
        height: Math.max(1, height),
      })
    },
    destroyView: (view) => reconciler.destroyView(VIEW_ID.tooltip, view),
    pushData: (view, data) => ctx.notify.tooltipInit(view, data),
    readyMode: 'manual',
  })

  let tooltipRequestId = 0
  let activeTooltip: { requestId: number; anchor: TooltipShowPayload['anchor'] } | null = null

  async function showSettings(): Promise<void> {
    const [w = 0, h = 0] = ctx.windows.mainWindow.getContentSize()
    settingsPanel.show(undefined, layout.computeSettingsBounds(w, h, overlayHeaderHeight()))
    await settingsPanel.whenReady()
  }

  function hideSettings(): void {
    settingsPanel.hide()
  }

  function showPopover(data: unknown): void {
    // Popover carries no state across opens (always fresh init data) — force a
    // brand-new instance rather than reusing/repositioning a live one (and
    // notify like any other close, via the shared hidePopover()).
    hidePopover()
    const [w = 0, h = 0] = ctx.windows.mainWindow.getContentSize()
    popoverPanel.show(data, layout.computePopoverBounds(w, h, overlayHeaderHeight()))
  }

  function hidePopover(): void {
    if (!popoverPanel.isPresent()) return
    popoverPanel.destroy()
    reconciler.deleteOverlayDesired(VIEW_ID.popover)
    reconciler.reconcileNow()
    ctx.notify.popoverClosed()
  }

  function prepareTooltip(): void {
    tooltipPanel.prepare()
  }

  function showTooltip(data: TooltipShowPayload): void {
    const requestId = ++tooltipRequestId
    activeTooltip = { requestId, anchor: data.anchor }
    const [contentWidth = 0] = ctx.windows.mainWindow.getContentSize()
    tooltipPanel.show({
      requestId,
      text: data.text,
      maxWidth: layout.computeTooltipMaxWidth(contentWidth),
    }, null)
  }

  function hideTooltip(): void {
    activeTooltip = null
    tooltipPanel.hide()
  }

  function markOverlayReady(webContentsId: number): void {
    settingsPanel.markReady(webContentsId)
    popoverPanel.markReady(webContentsId)
    tooltipPanel.markReady(webContentsId)
  }

  function applyTooltipMeasurement(
    webContentsId: number,
    measurement: { requestId: number; width: number; height: number },
  ): void {
    const active = activeTooltip
    if (!active || active.requestId !== measurement.requestId) return
    if (tooltipPanel.getWebContentsId() !== webContentsId) return
    const [w = 0, h = 0] = ctx.windows.mainWindow.getContentSize()
    tooltipPanel.reposition(layout.computeTooltipBounds(active.anchor, w, h, measurement))
  }

  function reapplyPresentOverlays(): void {
    if (settingsPanel.isPresent() && reconciler.hasOverlayDesired(VIEW_ID.settings)) void showSettings()
    if (popoverPanel.isPresent() && reconciler.hasOverlayDesired(VIEW_ID.popover)) {
      const [w = 0, h = 0] = ctx.windows.mainWindow.getContentSize()
      popoverPanel.reposition(layout.computePopoverBounds(w, h, overlayHeaderHeight()))
    }
  }

  function applySettingsBoundsIfPresent(): void {
    if (settingsPanel.isPresent() && reconciler.hasOverlayDesired(VIEW_ID.settings)) void showSettings()
  }

  function destroySettings(): void {
    activeTooltip = null
    settingsPanel.destroy()
    tooltipPanel.destroy()
  }

  return {
    showSettings,
    hideSettings,
    showPopover,
    hidePopover,
    prepareTooltip,
    showTooltip,
    hideTooltip,
    markOverlayReady,
    applyTooltipMeasurement,
    reapplyPresentOverlays,
    applySettingsBoundsIfPresent,
    destroySettings,
    getSettingsWebContents: () => settingsPanel.getWebContents(),
    getSettingsWebContentsId: () => settingsPanel.getWebContentsId(),
    getPopoverWebContentsId: () => popoverPanel.getWebContentsId(),
    getTooltipWebContentsId: () => tooltipPanel.getWebContentsId(),
  }
}
