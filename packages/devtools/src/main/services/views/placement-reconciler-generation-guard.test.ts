/**
 * Regression: `setPlacementSnapshot` used to clamp `rendererGeneration` to
 * never regress, but then unconditionally applied the incoming snapshot's
 * CONTENT into `baseDesired` and reconciled it under the clamped (i.e.
 * current) generation — regardless of whether the snapshot itself was
 * actually behind. That let a stale/dead source's late snapshot (e.g. a
 * screen's `dispose()` empty-snapshot flush, delivered after a successor
 * screen already advanced the generation) silently overwrite the currently
 * active screen's real views, because the reconcile core's own
 * generation-regression guard (placement-reconcile.ts: `snapshot.generation
 * < prev.generation`) never got to see the snapshot's real, lower
 * generation — only the clamped one.
 *
 * Every screen now draws its generation from one shared, strictly
 * increasing sequence (renderer-placement-generation.ts), so a legitimately
 * later mount is always numerically later than anything already accepted —
 * a lower-generation snapshot arriving after a higher one can therefore only
 * be a late arrival from an already-superseded source, never a legitimate
 * later update. `setPlacementSnapshot` hard-rejects it: no `baseDesired`
 * mutation, no reconcile call, `rendererGeneration` untouched.
 *
 * Drives `createPlacementReconciler` directly (no ViewManager/Electron
 * needed — its own runtime imports never touch `electron`).
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

describe('placement-reconciler: a lower-generation snapshot must be a complete no-op', () => {
  it('a stale/dead source\'s late, lower-generation snapshot does not touch the state a newer generation already established', () => {
    const { addChildView, removeChildView, ctx } = makeCtx()
    const reconciler = createPlacementReconciler(ctx)
    const view = makeView()
    reconciler.registerView(VIEW_ID.hostSidebar, { getView: () => view as never })

    const sidebarVisible = [{
      viewId: VIEW_ID.hostSidebar,
      placement: { visible: true, bounds: VISIBLE_BOUNDS },
      layer: VIEW_LAYER.hostSidebar,
    }]

    // A newer screen (higher generation, per the shared monotonic sequence)
    // has already placed the sidebar.
    reconciler.setPlacementSnapshot({ generation: 5, epoch: 1, views: sidebarVisible })
    expect(addChildView).toHaveBeenCalledTimes(1)

    // An older, already-superseded source's late snapshot arrives — e.g. a
    // previous screen's delayed `dispose()` flush (empty views, lower
    // generation). This must be dropped entirely: no detach of the sidebar
    // that generation 5 placed, and no further reconcile side effects at
    // all.
    reconciler.setPlacementSnapshot({ generation: 3, epoch: 2, views: [] })
    expect(
      removeChildView,
      'a stale snapshot must not remove a view a newer generation already placed',
    ).not.toHaveBeenCalled()
    expect(
      addChildView,
      'a rejected stale snapshot must not trigger any reconcile pass at all',
    ).toHaveBeenCalledTimes(1)

    // The high-water mark itself must also be untouched by the rejected
    // snapshot: a still-later, genuinely new generation-6 update reconciles
    // normally afterwards (proves `rendererGeneration` was not corrupted by
    // the rejected generation-3 call in either direction).
    reconciler.setPlacementSnapshot({ generation: 6, epoch: 3, views: sidebarVisible })
    expect(addChildView).toHaveBeenCalledTimes(2)
  })
})
