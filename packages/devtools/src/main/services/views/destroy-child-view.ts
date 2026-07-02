import type { BrowserWindow, WebContentsView } from 'electron'

/**
 * Detach a child overlay WebContentsView from the main window's contentView and
 * close its webContents. Tolerates an already-removed view and a destroyed
 * webContents (best-effort teardown). The single low-level view-destroy path
 * shared by every overlay domain.
 */
export function destroyChildView(
  mainWindow: BrowserWindow,
  view: WebContentsView | null,
): void {
  if (!view) return
  if (!mainWindow.isDestroyed()) {
    try {
      mainWindow.contentView.removeChildView(view)
    } catch { /* already removed */ }
  }
  try {
    if (!view.webContents.isDestroyed()) {
      view.webContents.close()
    }
  } catch { /* ignore */ }
}
