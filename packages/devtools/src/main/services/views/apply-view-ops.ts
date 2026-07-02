import type { Bounds, ViewOp } from '@dimina-kit/electron-deck/layout'
import type { DevtoolsExtra } from '../../../shared/view-ids.js'

// The side-effecting half of the reconcile loop. The pure core computes an
// ordered ViewOp list; this dispatches each op to the host's view tree via an
// injected target. The target owns viewId → WebContentsView resolution and lazy
// creation: `attach` creates-if-needed then addChildView (idempotent), so a
// reconcile that attaches a never-created view still works. Ops arrive already
// ordered (detach → hide → setBounds+attach → restore → update → reorder); the
// dispatcher must preserve that order and add none of its own.
export interface ViewOpTarget {
  // Create-if-needed + addChildView. Idempotent when already attached.
  attach(viewId: string): void
  // removeChildView + lifecycle close (view is leaving the tree for good).
  detach(viewId: string): void
  // setBounds (+ any extra-driven side effects, e.g. simulator zoomFactor).
  setBounds(viewId: string, bounds: Bounds, extra?: DevtoolsExtra): void
  // Electron WebContentsView.setVisible — hide without leaving the z-stack.
  setVisible(viewId: string, visible: boolean): void
  // Re-append attached views in the given bottom→top order to enforce z-order.
  reorder(order: string[]): void
}

export function applyViewOps(
  ops: ViewOp<DevtoolsExtra>[],
  target: ViewOpTarget,
): void {
  for (const op of ops) {
    switch (op.kind) {
      case 'detach':
        target.detach(op.viewId)
        break
      case 'setVisible':
        target.setVisible(op.viewId, op.visible)
        break
      case 'setBounds':
        target.setBounds(op.viewId, op.bounds, op.extra)
        break
      case 'attach':
        target.attach(op.viewId)
        break
      case 'reorder':
        target.reorder(op.order)
        break
    }
  }
}
