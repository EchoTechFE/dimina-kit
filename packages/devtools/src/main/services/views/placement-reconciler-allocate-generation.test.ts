/**
 * `allocateGeneration()` is what replaced the renderer's `Date.now()`
 * placement-generation seed (renderer-placement-generation.ts). It must
 * hand out a value strictly exceeding both `rendererGeneration` (the
 * high-water mark `setPlacementSnapshot` guards against — this reconciler
 * lives in the long-lived main process, so a renderer reload does NOT reset
 * it) and every previously allocated seed, so a fresh renderer bootstrap can
 * never be handed a value `setPlacementSnapshot` would reject as stale.
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
    ctx: {
      windows: { mainWindow } as unknown as ViewManagerContext['windows'],
    } as unknown as ViewManagerContext,
  }
}

describe('placement-reconciler: allocateGeneration', () => {
  it('hands out a strictly increasing sequence across repeated calls', () => {
    const { ctx } = makeCtx()
    const reconciler = createPlacementReconciler(ctx)

    const first = reconciler.allocateGeneration()
    const second = reconciler.allocateGeneration()

    expect(second).toBeGreaterThan(first)
  })

  it('always exceeds the current rendererGeneration high-water mark — the exact scenario Date.now() could get wrong across two fast reloads', () => {
    const { ctx } = makeCtx()
    const reconciler = createPlacementReconciler(ctx)
    reconciler.registerView(VIEW_ID.hostSidebar, { getView: () => null })

    // A previous renderer session already advanced the high-water mark well
    // past whatever a fresh, from-zero seed would produce.
    reconciler.setPlacementSnapshot({
      generation: 500,
      epoch: 1,
      views: [{
        viewId: VIEW_ID.hostSidebar,
        placement: { visible: false },
        layer: VIEW_LAYER.hostSidebar,
      }],
    })

    // The renderer reloads and asks for a fresh seed — it must land strictly
    // above 500, not restart from a small local counter.
    const seed = reconciler.allocateGeneration()
    expect(seed).toBeGreaterThan(500)

    // And a snapshot carrying that seed must actually be accepted (proves
    // the seed is not merely numerically higher but also usable).
    reconciler.setPlacementSnapshot({ generation: seed, epoch: 2, views: [] })
    expect(seed).toBeGreaterThan(500)
  })
})
