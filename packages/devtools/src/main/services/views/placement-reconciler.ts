import type { WebContentsView } from 'electron'
import * as layout from '../layout/index.js'
import { reconcile, createInitialState } from '@dimina-kit/electron-deck/layout'
import type {
  ActualView,
  DesiredView,
  PlacementSnapshot,
} from '@dimina-kit/electron-deck/layout'
import { applyViewOps, type ViewOpTarget } from './apply-view-ops.js'
import { createNativeViewTreeHost } from './native-view-tree.js'
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
  /**
   * When true, force the desired placement to hidden — the view-creation site
   * has not produced the WCV yet, so the reconciler must never record an attach
   * that addChildView can't perform. The creation site calls `reconcileNow()`
   * to re-open the gate.
   */
  gateHidden?(): boolean
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
  /** Size a detached view for renderer-side intrinsic measurement. */
  prepareView(viewId: string, view: WebContentsView, bounds: layout.Bounds): void
  /** Detach and close one concrete view instance through the native-tree owner. */
  destroyView(viewId: string, view: WebContentsView | null): void
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
  const appliedActual = new Map<string, ActualView<DevtoolsExtra>>()
  const baseDesired = new Map<string, DesiredView<DevtoolsExtra>>()
  const overlayDesired = new Map<string, DesiredView<DevtoolsExtra>>()
  const slots = new Map<string, ViewSlot>()

  // Sole owner of the main window's native child tree. Every attach, detach,
  // reorder and hard destroy passes through this ledger-backed adapter.
  const contentViewHost = createNativeViewTreeHost(ctx, slots)

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
      const view = slot.ensureView ? slot.ensureView() : slot.getView()
      if (!view) return
      if (!contentViewHost.addChildView({ id: viewId })) return
      const previous = appliedActual.get(viewId)
      appliedActual.set(viewId, {
        attached: true,
        visible: true,
        bounds: previous?.bounds,
        extra: previous?.extra,
      })
    },
    detach(viewId): void {
      if (!contentViewHost.removeChildView({ id: viewId })) return
      appliedActual.delete(viewId)
    },
    setBounds(viewId, bounds, extra): void {
      const slot = slots.get(viewId)
      const view = slot?.getView() ?? null
      if (!view || view.webContents.isDestroyed()) return
      try {
        if (slot?.applyBounds) slot.applyBounds(view, bounds, extra)
        else view.setBounds(bounds)
      } catch {
        return
      }
      const previous = appliedActual.get(viewId)
      appliedActual.set(viewId, {
        attached: previous?.attached ?? false,
        visible: previous?.visible ?? false,
        bounds,
        extra,
      })
    },
    setVisible(viewId, visible): void {
      const view = slots.get(viewId)?.getView() ?? null
      if (!view || view.webContents.isDestroyed()) return
      try { view.setVisible(visible) } catch { return }
      const previous = appliedActual.get(viewId)
      if (!previous) return
      appliedActual.set(viewId, { ...previous, visible })
    },
    reorder(order): void {
      // A single attached view is already in place — nothing to reorder.
      if (order.length <= 1 || ctx.windows.mainWindow.isDestroyed()) return
      for (const viewId of order) contentViewHost.addChildView({ id: viewId })
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

  function cloneAppliedActual(): Map<string, ActualView<DevtoolsExtra>> {
    return new Map([...appliedActual].map(([viewId, actual]) => [viewId, { ...actual }]))
  }

  function reconcileNow(): void {
    ensureLazyViews()
    const views: DesiredView<DevtoolsExtra>[] = []
    for (const v of baseDesired.values()) views.push(gateReadiness(v))
    for (const v of overlayDesired.values()) views.push(v)
    placementState = { ...placementState, actual: cloneAppliedActual() }
    const result = reconcile(placementState, {
      generation: rendererGeneration,
      epoch: ++epochCounter,
      views,
    })
    placementState = result.state
    applyViewOps(result.ops, viewTarget)
    // The planner's next state is optimistic. Keep only desired/epoch metadata;
    // appliedActual is updated by successful native effects above.
    placementState = { ...placementState, actual: cloneAppliedActual() }
  }

  function setPlacementSnapshot(snapshot: PlacementSnapshot<DevtoolsExtra>): void {
    // Defense-in-depth: `rendererGeneration` must never move backward. The
    // renderer is supposed to hand out one shared, strictly monotonic
    // sequence across every screen (see renderer-placement-generation.ts),
    // but if that invariant is ever violated, letting a lower value land
    // here would be worse than a no-op — the reconcile core's stale-
    // generation guard (placement-reconcile.ts) leaves `placementState`
    // untouched on rejection, so once `rendererGeneration` drops below the
    // already-accepted high-water mark, EVERY later snapshot compares as a
    // regression too and gets rejected forever, regardless of how current
    // it actually is. Clamping here keeps the high-water mark intact so a
    // lagging screen's own later, legitimately-newer snapshots still land.
    if (snapshot.generation >= rendererGeneration) {
      rendererGeneration = snapshot.generation
    } else {
      console.warn(
        `[placement-reconciler] snapshot generation ${snapshot.generation} is behind the current ${rendererGeneration}; ignoring the regression instead of adopting it`,
      )
    }
    baseDesired.clear()
    for (const v of snapshot.views) baseDesired.set(v.viewId, v)
    reconcileNow()
  }

  return {
    registerView: (viewId, slot) => { slots.set(viewId, slot) },
    reconcileNow,
    setPlacementSnapshot,
    prepareView: (viewId, view, bounds) => {
      if (slots.get(viewId)?.getView() !== view || view.webContents.isDestroyed()) return
      try { view.setBounds(bounds) } catch { return }
      appliedActual.set(viewId, { attached: false, visible: false, bounds })
    },
    destroyView: (viewId, view) => {
      contentViewHost.destroyView(viewId, view)
      appliedActual.delete(viewId)
      placementState.actual.delete(viewId)
    },
    setBaseDesired: (viewId, desired) => { baseDesired.set(viewId, desired) },
    deleteBaseDesired: (viewId) => { baseDesired.delete(viewId) },
    setOverlayDesired: (viewId, desired) => { overlayDesired.set(viewId, desired) },
    deleteOverlayDesired: (viewId) => { overlayDesired.delete(viewId) },
    hasOverlayDesired: (viewId) => overlayDesired.has(viewId),
  }
}
