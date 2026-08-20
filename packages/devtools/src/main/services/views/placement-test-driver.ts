// Test-only helper: drives the view manager through its real runtime entry
// point, `setPlacementSnapshot`, the way the renderer's central publisher does
// — accumulating each view's desired placement (per manager) and publishing the
// WHOLE table under a monotonic epoch. A single-view update thus keeps the other
// views' last-declared placement, matching the renderer's level-triggered stream
// rather than the old per-view setXxxBounds edges. These free functions let the
// many view-manager tests exercise reconcile behaviour with a drop-in rename
// (`mgr.setHostToolbarBounds(r)` → `hostToolbarBounds(mgr, r)`).

import type { DesiredView } from '@dimina-kit/electron-deck/layout'
import { VIEW_ID, VIEW_LAYER, type DevtoolsExtra } from '../../../shared/view-ids.js'

interface Rect { x: number; y: number; width: number; height: number }

interface SnapshotSink {
  setPlacementSnapshot(snapshot: {
    generation: number
    epoch: number
    views: DesiredView<DevtoolsExtra>[]
  }): void
}

interface OverlaySink {
  showSettings(): Promise<void>
  showPopover(data: unknown): void
  showTooltip(data: { anchor: Rect; text: string }): void
  getSettingsWebContentsId(): number | null
  getPopoverWebContentsId(): number | null
  getTooltipWebContentsId(): number | null
  markOverlayReady(webContentsId: number): void
  applyTooltipMeasurement(
    webContentsId: number,
    measurement: { requestId: number; width: number; height: number },
  ): void
}

// Monotonic across every push in a test file (vitest isolates module state per
// file), so a fresh manager (lastEpoch -1) accepts the first push and repeated
// pushes on one manager never look stale.
let globalEpoch = 0
const desiredByMgr = new WeakMap<SnapshotSink, Map<string, DesiredView<DevtoolsExtra>>>()
const tooltipRequestByMgr = new WeakMap<OverlaySink, number>()

function toPlacement(r: Rect): DesiredView<DevtoolsExtra>['placement'] {
  return r.width > 0 && r.height > 0 ? { visible: true, bounds: r } : { visible: false }
}

function pushView(mgr: SnapshotSink, view: DesiredView<DevtoolsExtra>, generation = 1): void {
  let desired = desiredByMgr.get(mgr)
  if (!desired) { desired = new Map(); desiredByMgr.set(mgr, desired) }
  desired.set(view.viewId, view)
  mgr.setPlacementSnapshot({ generation, epoch: globalEpoch++, views: [...desired.values()] })
}

export function hostToolbarBounds(mgr: SnapshotSink, rect: Rect): void {
  pushView(mgr, { viewId: VIEW_ID.hostToolbar, placement: toPlacement(rect), layer: VIEW_LAYER.hostToolbar })
}

export function simulatorDevtoolsBounds(mgr: SnapshotSink, rect: Rect): void {
  pushView(mgr, { viewId: VIEW_ID.simulatorDevtools, placement: toPlacement(rect), layer: VIEW_LAYER.base })
}

export function workbenchBounds(mgr: SnapshotSink, rect: Rect): void {
  pushView(mgr, { viewId: VIEW_ID.workbench, placement: toPlacement(rect), layer: VIEW_LAYER.base })
}

export async function showSettingsReady(mgr: OverlaySink): Promise<void> {
  const shown = mgr.showSettings()
  const webContentsId = mgr.getSettingsWebContentsId()
  if (webContentsId === null) throw new Error('settings view was not created')
  mgr.markOverlayReady(webContentsId)
  await shown
}

export function showPopoverReady(mgr: OverlaySink, data: unknown): void {
  mgr.showPopover(data)
  const webContentsId = mgr.getPopoverWebContentsId()
  if (webContentsId === null) throw new Error('popover view was not created')
  mgr.markOverlayReady(webContentsId)
}

export function showTooltipReady(
  mgr: OverlaySink,
  data: { anchor: Rect; text: string },
  size: { width: number; height: number } = { width: 80, height: 28 },
): void {
  mgr.showTooltip(data)
  const webContentsId = mgr.getTooltipWebContentsId()
  if (webContentsId === null) throw new Error('tooltip view was not created')
  mgr.markOverlayReady(webContentsId)
  const requestId = (tooltipRequestByMgr.get(mgr) ?? 0) + 1
  tooltipRequestByMgr.set(mgr, requestId)
  mgr.applyTooltipMeasurement(webContentsId, { requestId, ...size })
}

export function simulatorBounds(mgr: SnapshotSink, params: Rect & { zoom: number }): void {
  const { zoom, ...rect } = params
  pushView(mgr, { viewId: VIEW_ID.simulator, placement: toPlacement(rect), layer: VIEW_LAYER.base, extra: { zoom } })
}

/** Drop a view from this manager's desired table (reconcile detaches it). */
export function removeView(mgr: SnapshotSink, viewId: string): void {
  const desired = desiredByMgr.get(mgr)
  if (!desired) return
  desired.delete(viewId)
  mgr.setPlacementSnapshot({ generation: 1, epoch: globalEpoch++, views: [...desired.values()] })
}
