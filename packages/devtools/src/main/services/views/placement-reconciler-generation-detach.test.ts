/**
 * A higher-generation snapshot (renderer crash/reload) must still detach a
 * really-attached native view if the new generation's snapshot doesn't
 * redeclare it — the pure reconcile core carries `prev.actual` forward
 * across a generation bump specifically so `scanDetached` can still see and
 * diff out ids the new generation is silent about (placement-reconcile.ts).
 * This test drives that through `createPlacementReconciler`'s real applied-
 * view ledger (`appliedActual`, re-injected into `prev.actual` on every
 * `reconcileNow` call) to prove the REAL native view actually gets removed,
 * not just that the pure core's in-memory state loses the id.
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

describe('placement-reconciler: a generation bump must still detach a real view the new generation omits', () => {
  it('removes the actual native view when the higher-generation snapshot never redeclares it', () => {
    const { removeChildView, ctx } = makeCtx()
    const reconciler = createPlacementReconciler(ctx)
    const view = makeView()
    reconciler.registerView(VIEW_ID.hostSidebar, { getView: () => view as never })

    // Generation 0 attaches the sidebar for real (appliedActual now tracks it
    // as attached).
    reconciler.setPlacementSnapshot({
      generation: 0,
      epoch: 1,
      views: [{
        viewId: VIEW_ID.hostSidebar,
        placement: { visible: true, bounds: VISIBLE_BOUNDS },
        layer: VIEW_LAYER.hostSidebar,
      }],
    })
    expect(view.setBounds).toHaveBeenCalledWith(VISIBLE_BOUNDS)

    // Generation 1 is a fresh renderer (crash/reload) whose first snapshot
    // doesn't mention the sidebar at all — it hasn't gotten around to
    // redeclaring it yet, or genuinely doesn't want it. The still-really-
    // attached view from generation 0 must be detached, not silently
    // forgotten and left on screen.
    reconciler.setPlacementSnapshot({ generation: 1, epoch: 0, views: [] })

    expect(
      removeChildView,
      'a genuinely orphaned view from a superseded generation must still be detached',
    ).toHaveBeenCalledTimes(1)
  })
})
