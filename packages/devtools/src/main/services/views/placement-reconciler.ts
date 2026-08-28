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
 * only (serial) reconcile caller, so the core's stale-epoch guard passes by
 * construction; `rendererGeneration` is the high-water mark that drives both
 * the reset on a genuinely newer generation and the hard rejection of a
 * snapshot from behind it (see `setPlacementSnapshot`).
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
  /**
   * Hand out a fresh generation seed for a renderer bootstrap (see
   * renderer-placement-generation.ts). Strictly exceeds both the current
   * high-water mark (`rendererGeneration`, which a full renderer reload does
   * NOT reset — this reconciler lives in the long-lived main process) and
   * every previously allocated seed, so a reload that races ahead of its own
   * previous session's accepted snapshots can never be handed a value that
   * `setPlacementSnapshot` would reject as stale.
   */
  allocateGeneration(): number
}

export function createPlacementReconciler(ctx: ViewManagerContext): PlacementReconciler {
  let placementState = createInitialState<DevtoolsExtra>()
  let epochCounter = 0
  let rendererGeneration = 0
  let allocatedGeneration = 0
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
    // Hard reject a snapshot from BEHIND the current high-water mark — a
    // complete no-op, touching neither `rendererGeneration` nor
    // `baseDesired`. The renderer hands out one shared, strictly monotonic
    // sequence across every screen (see renderer-placement-generation.ts),
    // so under normal operation a lower generation can only be a LATE
    // arrival from an already-superseded source (e.g. a dead screen's
    // delayed `dispose()` empty-snapshot flush racing a successor screen's
    // mount). The previous version of this guard clamped
    // `rendererGeneration` to never regress but still unconditionally
    // applied the stale snapshot's CONTENT into `baseDesired` under the
    // clamped (i.e. current) generation number — which defeated the
    // reconcile core's own generation-regression guard
    // (placement-reconcile.ts: `snapshot.generation < prev.generation`) by
    // never letting it see the snapshot's real, lower generation. That let a
    // dead screen's stale/empty view list silently overwrite a currently
    // active screen's real views. Dropping it here, before it ever reaches
    // `baseDesired`, is what actually gives the stale snapshot zero side
    // effects.
    if (snapshot.generation < rendererGeneration) {
      console.warn(
        `[placement-reconciler] snapshot generation ${snapshot.generation} is behind the current ${rendererGeneration}; dropping without applying its content`,
      )
      return
    }
    rendererGeneration = snapshot.generation
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
    allocateGeneration: () => {
      allocatedGeneration = Math.max(allocatedGeneration, rendererGeneration) + 1
      return allocatedGeneration
    },
  }
}
