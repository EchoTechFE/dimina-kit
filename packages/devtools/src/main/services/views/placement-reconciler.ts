import type { WebContentsView } from 'electron'
import * as layout from '../layout/index.js'
import { reconcile, createInitialState } from '@dimina-kit/electron-deck/layout'
import type {
  DesiredView,
  PlacementSnapshot,
} from '@dimina-kit/electron-deck/layout'
import { applyViewOps, type ViewOpTarget } from './apply-view-ops.js'
import type { DevtoolsExtra } from '../../../shared/view-ids.js'
import type { ViewManagerContext } from './view-manager.js'

/**
 * The per-view wiring the reconciler needs to converge the main-process view
 * tree. Each view domain registers exactly one slot; the reconciler owns no
 * view references itself, so the domain's own `let viewRef` stays the single
 * source of truth (the slot exposes accessors into it, never a copy).
 */
export interface ViewSlot {
  /** The live WebContentsView for this slot, or null when not yet created. */
  getView(): WebContentsView | null
  /** Record whether the view is currently added to the contentView. */
  setAdded?(added: boolean): void
  /**
   * When true, force the desired placement to hidden — the view-creation site
   * has not produced the WCV yet, so the reconciler must never record an attach
   * that addChildView can't perform. The creation site calls `reconcileNow()`
   * to re-open the gate.
   */
  gateHidden?(): boolean
  /**
   * Run before the generic attach. Return true when the slot fully handled the
   * attach itself (e.g. a lazy async load that adds the view on completion), so
   * the reconciler must NOT addChildView here.
   */
  beforeAttach?(): boolean
  /** Lazily create the view on attach (host-toolbar); used instead of getView. */
  ensureView?(): WebContentsView | null
  /** Domain-specific setBounds (simulator zoom rides here). */
  applyBounds?(
    view: WebContentsView,
    bounds: layout.Bounds,
    extra: DevtoolsExtra | undefined,
  ): void
  /**
   * Create the lazily-built view BEFORE reconcile when its desired placement is
   * visible, so the setBounds op — which the core emits before attach — lands
   * on a live view rather than a not-yet-created one.
   */
  ensureLazy?(desired: DesiredView<DevtoolsExtra> | undefined): void
}

/**
 * Level-triggered placement reconciler (docs/view-placement-reconciler.md). The
 * renderer publishes a window-level snapshot into `baseDesired`;
 * settings/popover are main-owned and live in `overlayDesired`. Any change
 * merges the two, runs the pure reconcile core, and applies the ordered ops
 * through `viewTarget`. `epochCounter` is a single monotonic tick — main is the
 * only (serial) reconcile caller, so the core's stale guard passes by
 * construction; `rendererGeneration` still drives the reset on renderer restart.
 */
export interface PlacementReconciler {
  registerView(viewId: string, slot: ViewSlot): void
  reconcileNow(): void
  /**
   * Apply the renderer's window-level placement snapshot — the single source of
   * truth for every managed native view's bounds/visibility/z-order.
   */
  setPlacementSnapshot(snapshot: PlacementSnapshot<DevtoolsExtra>): void
  /**
   * Forget a view's reconciled mount state so the NEXT rebuilt view is treated
   * as a fresh attach. Required wherever a view instance is replaced/destroyed
   * via a manual removeChildView that bypasses the reconciler (otherwise the
   * level-triggered core still records the old instance as attached and never
   * emits the attach op for the replacement — a sticky invisible view).
   */
  forgetActual(viewId: string): void
  setBaseDesired(viewId: string, desired: DesiredView<DevtoolsExtra>): void
  deleteBaseDesired(viewId: string): void
  setOverlayDesired(viewId: string, desired: DesiredView<DevtoolsExtra>): void
  deleteOverlayDesired(viewId: string): void
  hasOverlayDesired(viewId: string): boolean
}

export function createPlacementReconciler(ctx: ViewManagerContext): PlacementReconciler {
  let placementState = createInitialState<DevtoolsExtra>()
  let epochCounter = 0
  let rendererGeneration = 0
  const baseDesired = new Map<string, DesiredView<DevtoolsExtra>>()
  const overlayDesired = new Map<string, DesiredView<DevtoolsExtra>>()
  const slots = new Map<string, ViewSlot>()

  function gateReadiness(v: DesiredView<DevtoolsExtra>): DesiredView<DevtoolsExtra> {
    const slot = slots.get(v.viewId)
    if (slot?.gateHidden?.()) return { ...v, placement: { visible: false } }
    return v
  }

  const viewTarget: ViewOpTarget = {
    attach(viewId): void {
      if (ctx.windows.mainWindow.isDestroyed()) return
      const slot = slots.get(viewId)
      if (!slot) return
      if (slot.beforeAttach?.()) return
      const view = slot.ensureView ? slot.ensureView() : slot.getView()
      if (!view) return
      ctx.windows.mainWindow.contentView.addChildView(view)
      slot.setAdded?.(true)
    },
    detach(viewId): void {
      const slot = slots.get(viewId)
      const view = slot?.getView() ?? null
      if (view && !ctx.windows.mainWindow.isDestroyed()) {
        try { ctx.windows.mainWindow.contentView.removeChildView(view) } catch { /* already removed */ }
      }
      slot?.setAdded?.(false)
    },
    setBounds(viewId, bounds, extra): void {
      const slot = slots.get(viewId)
      const view = slot?.getView() ?? null
      if (!view || view.webContents.isDestroyed()) return
      if (slot?.applyBounds) {
        slot.applyBounds(view, bounds, extra)
        return
      }
      view.setBounds(bounds)
    },
    setVisible(viewId, visible): void {
      const view = slots.get(viewId)?.getView() ?? null
      if (!view) return
      try { view.setVisible(visible) } catch { /* stub may lack setVisible */ }
    },
    reorder(order): void {
      // A single attached view is already in place — nothing to reorder.
      if (order.length <= 1 || ctx.windows.mainWindow.isDestroyed()) return
      const cv = ctx.windows.mainWindow.contentView
      for (const viewId of order) {
        const view = slots.get(viewId)?.getView() ?? null
        if (view) {
          try { cv.addChildView(view) } catch { /* already attached */ }
        }
      }
    },
  }

  // Create the lazily-built views (host-toolbar, workbench) BEFORE reconcile so
  // the setBounds op — which the core emits before attach — lands on a live view
  // rather than a not-yet-created one.
  function ensureLazyViews(): void {
    for (const [viewId, slot] of slots) {
      slot.ensureLazy?.(baseDesired.get(viewId))
    }
  }

  function reconcileNow(): void {
    ensureLazyViews()
    const views: DesiredView<DevtoolsExtra>[] = []
    for (const v of baseDesired.values()) views.push(gateReadiness(v))
    for (const v of overlayDesired.values()) views.push(v)
    const result = reconcile(placementState, {
      generation: rendererGeneration,
      epoch: ++epochCounter,
      views,
    })
    placementState = result.state
    applyViewOps(result.ops, viewTarget)
  }

  function setPlacementSnapshot(snapshot: PlacementSnapshot<DevtoolsExtra>): void {
    rendererGeneration = snapshot.generation
    baseDesired.clear()
    for (const v of snapshot.views) baseDesired.set(v.viewId, v)
    reconcileNow()
  }

  return {
    registerView: (viewId, slot) => { slots.set(viewId, slot) },
    reconcileNow,
    setPlacementSnapshot,
    forgetActual: (viewId) => { placementState.actual.delete(viewId) },
    setBaseDesired: (viewId, desired) => { baseDesired.set(viewId, desired) },
    deleteBaseDesired: (viewId) => { baseDesired.delete(viewId) },
    setOverlayDesired: (viewId, desired) => { overlayDesired.set(viewId, desired) },
    deleteOverlayDesired: (viewId) => { overlayDesired.delete(viewId) },
    hasOverlayDesired: (viewId) => overlayDesired.has(viewId),
  }
}
