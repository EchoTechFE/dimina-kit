import type { BrowserWindow, WebContentsView } from 'electron'
import type { ContentViewHost, NativeViewRef } from '@dimina-kit/electron-deck/main'
import type { ViewSlot } from './placement-reconciler.js'

/**
 * The `ContentViewHost` electron-deck's `Compositor` needs, adapted onto
 * devtools' own `mainWindow.contentView` + `slots` (the existing "resolve the
 * live view instance for a viewId" registry `placement-reconciler.ts` already
 * maintains — views get rebuilt in place, same viewId, so resolution must stay
 * dynamic, not a snapshot taken at registration time). A minimal Electron
 * `contentView` has no `.children()`, so — mirroring electron-deck's own
 * `deck-app.ts` `createWindowSubstrate` — order is tracked locally, updated
 * only after the native call it mirrors succeeds.
 */
export interface ReconcilerContentViewHost extends ContentViewHost {
  /** Drop a viewId from the tracked order with NO native call — for a view
   *  that already left `contentView` via a raw (non-Compositor) removal
   *  elsewhere, so a later `mount()` for the same id isn't treated as an
   *  idempotent no-op against stale bookkeeping. Paired with
   *  `PlacementReconciler.forgetActual`. */
  forget(viewId: string): void
}

export function createReconcilerContentViewHost(
  ctx: { windows: { mainWindow: BrowserWindow } },
  slots: Map<string, ViewSlot>,
): ReconcilerContentViewHost {
  const order: string[] = []

  function resolve(id: string): WebContentsView | null {
    return slots.get(id)?.getView() ?? null
  }

  return {
    addChildView(ref: NativeViewRef): void {
      const view = resolve(ref.id)
      if (!view || ctx.windows.mainWindow.isDestroyed()) return
      ctx.windows.mainWindow.contentView.addChildView(view)
      const i = order.indexOf(ref.id)
      if (i >= 0) order.splice(i, 1)
      order.push(ref.id)
    },
    removeChildView(ref: NativeViewRef): void {
      const view = resolve(ref.id)
      if (view && !ctx.windows.mainWindow.isDestroyed()) {
        ctx.windows.mainWindow.contentView.removeChildView(view)
      }
      const i = order.indexOf(ref.id)
      if (i >= 0) order.splice(i, 1)
    },
    get isDestroyed() {
      return ctx.windows.mainWindow.isDestroyed()
    },
    children: () => order.map((id) => ({ id })),
    forget(viewId: string): void {
      const i = order.indexOf(viewId)
      if (i >= 0) order.splice(i, 1)
    },
  }
}
