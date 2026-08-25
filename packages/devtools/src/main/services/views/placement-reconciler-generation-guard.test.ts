/**
 * Regression: `setPlacementSnapshot` used to assign
 * `rendererGeneration = snapshot.generation` unconditionally. Two independent
 * per-screen renderer counters (ProjectListScreen, ProjectRuntime — see
 * project-list-screen.tsx / project-runtime.tsx) can report generations out
 * of the order main already accepted (e.g. a project screen has already sent
 * generation 3 while a lagging list-screen mount reports generation 1). Once
 * that lower value lands in `rendererGeneration`, the reconcile core's
 * generation-regression guard (placement-reconcile.ts: `snapshot.generation <
 * prev.generation`) rejects it on the spot — but because a rejection leaves
 * `prev.generation` untouched, every SUBSEQUENT call built from that same
 * depressed `rendererGeneration` keeps failing the same check, forever,
 * regardless of how legitimate that later call actually is. No native view
 * ever reconciles again until the lagging counter happens to climb back
 * above the frozen high-water mark.
 *
 * This drives `createPlacementReconciler` directly (no ViewManager/Electron
 * needed — its own runtime imports never touch `electron`) to pin that a
 * lower-generation snapshot must not drag `rendererGeneration` backward.
 */
import { describe, it, expect, vi } from 'vitest'
import { createPlacementReconciler } from './placement-reconciler.js'
import type { ViewManagerContext } from './view-manager.js'
import { VIEW_ID, VIEW_LAYER } from '../../../shared/view-ids.js'

function makeCtx() {
  const addChildView = vi.fn()
  const removeChildView = vi.fn()
  const mainWindow = {
    destroyed: false,
    isDestroyed(this: { destroyed: boolean }) { return this.destroyed },
    contentView: { addChildView, removeChildView, children: [] as unknown[] },
  }
  return {
    addChildView,
    removeChildView,
    ctx: {
      windows: { mainWindow } as unknown as ViewManagerContext['windows'],
    } as unknown as ViewManagerContext,
  }
}

function makeView() {
  return {
    webContents: { isDestroyed: () => false },
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    setBackgroundColor: vi.fn(),
  }
}

const VISIBLE_BOUNDS = { x: 0, y: 0, width: 320, height: 800 }

describe('placement-reconciler: a lower-generation snapshot must not permanently freeze reconciliation', () => {
  it('a later, still-lower-than-peak generation update from the SAME lagging screen keeps applying afterwards', () => {
    const { addChildView, ctx } = makeCtx()
    const reconciler = createPlacementReconciler(ctx)
    const view = makeView()
    reconciler.registerView(VIEW_ID.hostSidebar, { getView: () => view as never })

    const sidebarVisible = [{
      viewId: VIEW_ID.hostSidebar,
      placement: { visible: true, bounds: VISIBLE_BOUNDS },
      layer: VIEW_LAYER.hostSidebar,
    }]

    // High-generation screen (e.g. a project mount) places the sidebar.
    reconciler.setPlacementSnapshot({ generation: 3, epoch: 1, views: sidebarVisible })
    expect(addChildView).toHaveBeenCalledTimes(1)

    // A lagging screen's own, independently-numbered generation (1) — behind
    // the high-water mark another screen already pushed past it.
    reconciler.setPlacementSnapshot({ generation: 1, epoch: 2, views: [] })

    // That SAME lagging screen's very next, organically-incremented update
    // (generation 2, still below the already-accepted high-water mark of 3)
    // showing the sidebar again. This MUST still reconcile: if the previous
    // call had dragged `rendererGeneration` down to 1, this generation-2
    // snapshot would ALSO compare as `< prev.generation(3)` and be silently
    // dropped — the exact permanent freeze this guards against, where no
    // further update from the lagging screen ever reaches the screen again.
    reconciler.setPlacementSnapshot({ generation: 2, epoch: 3, views: sidebarVisible })
    expect(
      addChildView,
      'a later legitimate update from the lagging screen must still reconcile — otherwise every native view is frozen at its last-accepted placement forever',
    ).toHaveBeenCalledTimes(2)
  })
})
