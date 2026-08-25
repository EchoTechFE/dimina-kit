import type { WebContents } from 'electron'
import { WebContentsView } from 'electron'
import { createOverlayPanel, type OverlayPanel } from '@dimina-kit/electron-deck/main'
import { mainPreloadPath } from '../../utils/paths.js'
import { applyNavigationHardening } from '../../windows/navigation-hardening.js'
import * as layout from '../layout/index.js'
import { HEADER_H } from '../../../shared/constants.js'
import { VIEW_ID, VIEW_LAYER } from '../../../shared/view-ids.js'
import { UpdateChannel } from '../../../shared/ipc-channels-overlays.js'
import type { UpdateInfo } from '../../../shared/types.js'
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

/** Payload shown by the project-create-dialog overlay panel (`projectCreate:show`). */
export interface ProjectCreateShowPayload {
  templates: unknown[]
  defaultBaseDir: string
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
  /** Destroy the project-create/update dialog panel views (app-level teardown). */
  destroyDialogs(): void
  getSettingsWebContents(): WebContents | null
  getSettingsWebContentsId(): number | null
  getPopoverWebContentsId(): number | null
  getTooltipWebContentsId(): number | null
  /**
   * Show the project-create-dialog overlay panel (VIEW_LAYER.dialog) — the
   * real WebContentsView that replaced the Radix `fixed inset-0` DOM portal
   * (see view-ids.ts's VIEW_LAYER doc-comment for why a DOM overlay can't
   * paint above the simulator/host-toolbar/host-sidebar WCVs).
   */
  showProjectCreateDialog(data: ProjectCreateShowPayload): void
  hideProjectCreateDialog(): void
  /** Show the update-available overlay panel, fed the discovered update's info. */
  showUpdateDialog(data: UpdateInfo): void
  hideUpdateDialog(): void
  /** Forward a download-progress tick into the (already-shown) update overlay. */
  notifyUpdateDownloadProgress(percent: number): void
  getProjectCreateDialogWebContentsId(): number | null
  getUpdateDialogWebContentsId(): number | null
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

  /**
   * Both devtools-owned dialog panels occupy the full main-window content
   * rect (they render their own centered card + backdrop), so unlike
   * settings/popover/tooltip they need no anchor-derived bounds computation —
   * just the window's current content size, recomputed on every show/resize.
   */
  function fullWindowBounds(): layout.Bounds {
    const [width = 0, height = 0] = ctx.windows.mainWindow.getContentSize()
    return { x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) }
  }

  const projectCreateDialogPanel: OverlayPanel<ProjectCreateShowPayload> = createOverlayPanel<ProjectCreateShowPayload>({
    electron: { createWebContentsView: (opts) => new WebContentsView(opts) },
    rendererDir: ctx.rendererDir,
    entry: 'entries/project-create-dialog/index.html',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: mainPreloadPath,
    },
    hardenNavigation: (wc) => applyNavigationHardening(wc, ctx.rendererDir),
    setDesired: overlayDesiredSetter(VIEW_ID.projectCreateDialog, VIEW_LAYER.dialog),
    registerView: (getView) => reconciler.registerView(VIEW_ID.projectCreateDialog, { getView }),
    destroyView: (view) => reconciler.destroyView(VIEW_ID.projectCreateDialog, view),
    pushData: (view, data) => ctx.notify.projectCreateInit(view, data),
    readyMode: 'manual',
  })

  const updateDialogPanel: OverlayPanel<UpdateInfo> = createOverlayPanel<UpdateInfo>({
    electron: { createWebContentsView: (opts) => new WebContentsView(opts) },
    rendererDir: ctx.rendererDir,
    entry: 'entries/update-dialog/index.html',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: mainPreloadPath,
    },
    hardenNavigation: (wc) => applyNavigationHardening(wc, ctx.rendererDir),
    setDesired: overlayDesiredSetter(VIEW_ID.updateDialog, VIEW_LAYER.dialog),
    registerView: (getView) => reconciler.registerView(VIEW_ID.updateDialog, { getView }),
    destroyView: (view) => reconciler.destroyView(VIEW_ID.updateDialog, view),
    pushData: (view, data) => ctx.notify.updateAvailable(view, data),
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

  function showProjectCreateDialog(data: ProjectCreateShowPayload): void {
    projectCreateDialogPanel.show(data, fullWindowBounds())
  }

  function hideProjectCreateDialog(): void {
    projectCreateDialogPanel.hide()
  }

  function showUpdateDialog(data: UpdateInfo): void {
    updateDialogPanel.show(data, fullWindowBounds())
  }

  function hideUpdateDialog(): void {
    updateDialogPanel.hide()
  }

  function notifyUpdateDownloadProgress(percent: number): void {
    const wc = updateDialogPanel.getWebContents()
    if (!wc) return
    wc.send(UpdateChannel.DownloadProgress, { percent })
  }

  function markOverlayReady(webContentsId: number): void {
    settingsPanel.markReady(webContentsId)
    popoverPanel.markReady(webContentsId)
    tooltipPanel.markReady(webContentsId)
    projectCreateDialogPanel.markReady(webContentsId)
    updateDialogPanel.markReady(webContentsId)
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
    // Fire-and-forget re-trigger — a crash between this call and the panel
    // becoming ready now rejects whenReady() (see overlay-panel.ts teardown);
    // handleViewBroken() already logs it, nothing more to do here.
    if (settingsPanel.isPresent() && reconciler.hasOverlayDesired(VIEW_ID.settings)) {
      showSettings().catch(() => {})
    }
    if (popoverPanel.isPresent() && reconciler.hasOverlayDesired(VIEW_ID.popover)) {
      const [w = 0, h = 0] = ctx.windows.mainWindow.getContentSize()
      popoverPanel.reposition(layout.computePopoverBounds(w, h, overlayHeaderHeight()))
    }
    if (projectCreateDialogPanel.isPresent() && reconciler.hasOverlayDesired(VIEW_ID.projectCreateDialog)) {
      projectCreateDialogPanel.reposition(fullWindowBounds())
    }
    if (updateDialogPanel.isPresent() && reconciler.hasOverlayDesired(VIEW_ID.updateDialog)) {
      updateDialogPanel.reposition(fullWindowBounds())
    }
  }

  function applySettingsBoundsIfPresent(): void {
    // See reapplyPresentOverlays() above for why this swallows a rejection.
    if (settingsPanel.isPresent() && reconciler.hasOverlayDesired(VIEW_ID.settings)) {
      showSettings().catch(() => {})
    }
  }

  function destroySettings(): void {
    activeTooltip = null
    settingsPanel.destroy()
    tooltipPanel.destroy()
  }

  function destroyDialogs(): void {
    projectCreateDialogPanel.destroy()
    updateDialogPanel.destroy()
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
    showProjectCreateDialog,
    hideProjectCreateDialog,
    showUpdateDialog,
    hideUpdateDialog,
    notifyUpdateDownloadProgress,
    reapplyPresentOverlays,
    applySettingsBoundsIfPresent,
    destroySettings,
    destroyDialogs,
    getSettingsWebContents: () => settingsPanel.getWebContents(),
    getSettingsWebContentsId: () => settingsPanel.getWebContentsId(),
    getPopoverWebContentsId: () => popoverPanel.getWebContentsId(),
    getTooltipWebContentsId: () => tooltipPanel.getWebContentsId(),
    getProjectCreateDialogWebContentsId: () => projectCreateDialogPanel.getWebContentsId(),
    getUpdateDialogWebContentsId: () => updateDialogPanel.getWebContentsId(),
  }
}
