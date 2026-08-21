import type { BrowserWindow, WebContentsView } from 'electron'
import type { ViewSlot } from './placement-reconciler.js'

/**
 * Single native child-tree owner for devtools. It resolves the current concrete
 * instance dynamically because a stable viewId may be rebuilt, and updates its
 * order ledger only after the corresponding Electron call succeeds.
 */
interface NativeViewRef { readonly id: string }

export interface NativeViewTreeHost {
  addChildView(ref: NativeViewRef): boolean
  removeChildView(ref: NativeViewRef): boolean
  readonly isDestroyed: boolean
  children(): readonly NativeViewRef[]
  /** Detach and close a concrete instance, then remove it from the ledger. */
  destroyView(viewId: string, view: WebContentsView | null): void
}

export function createNativeViewTreeHost(
  ctx: { windows: { mainWindow: BrowserWindow } },
  slots: Map<string, ViewSlot>,
): NativeViewTreeHost {
  const order: string[] = []
  const mounted = new Map<string, WebContentsView>()

  function resolve(id: string): WebContentsView | null {
    return slots.get(id)?.getView() ?? null
  }

  return {
    addChildView(ref: NativeViewRef): boolean {
      const view = resolve(ref.id)
      if (!view || view.webContents.isDestroyed() || ctx.windows.mainWindow.isDestroyed()) return false
      try {
        ctx.windows.mainWindow.contentView.addChildView(view)
      } catch {
        return false
      }
      const i = order.indexOf(ref.id)
      if (i >= 0) order.splice(i, 1)
      order.push(ref.id)
      mounted.set(ref.id, view)
      return true
    },
    removeChildView(ref: NativeViewRef): boolean {
      const view = mounted.get(ref.id) ?? null
      if (!view || ctx.windows.mainWindow.isDestroyed()) return false
      try {
        ctx.windows.mainWindow.contentView.removeChildView(view)
      } catch {
        return false
      }
      const i = order.indexOf(ref.id)
      if (i >= 0) order.splice(i, 1)
      mounted.delete(ref.id)
      return true
    },
    get isDestroyed() {
      return ctx.windows.mainWindow.isDestroyed()
    },
    children: () => order.map((id) => ({ id })),
    destroyView(viewId: string, view: WebContentsView | null): void {
      const isMountedInstance = view !== null && mounted.get(viewId) === view
      if (view && !ctx.windows.mainWindow.isDestroyed()) {
        try { ctx.windows.mainWindow.contentView.removeChildView(view) } catch { /* detached */ }
      }
      if (isMountedInstance) {
        const i = order.indexOf(viewId)
        if (i >= 0) order.splice(i, 1)
        mounted.delete(viewId)
      }
      if (view) {
        try {
          if (!view.webContents.isDestroyed()) view.webContents.close()
        } catch { /* destroyed concurrently */ }
      }
    },
  }
}
