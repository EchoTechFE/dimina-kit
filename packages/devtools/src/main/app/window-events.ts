import { app, BrowserWindow } from 'electron'
import fs from 'fs'
import { toDisposable, type Disposable } from '@dimina-kit/electron-deck/main'

/**
 * Bring `win` back in front of the user from any hidden or minimized state.
 *
 * The project-list window hides instead of closing while projects are open —
 * it owns app-level IPC that cannot be registered a second time, so it must
 * outlive its own close button — which makes "show the project list" a real
 * operation with several entry points (the menu, a macOS dock activate, the
 * last project window closing). They all go through here so none of them can
 * drift into handling only some of the hidden states.
 */
export function revealWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export function enableDevRendererAutoReload(rendererDir: string): Disposable {
  // Auto-reload renderer windows when dist files change during development
  if (app.isPackaged) {
    return toDisposable(() => {})
  }

  let reloadTimer: ReturnType<typeof setTimeout> | null = null
  const watcher = fs.watch(rendererDir, { recursive: true }, () => {
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.reload()
      }
    }, 300)
  })

  return toDisposable(() => {
    if (reloadTimer) {
      clearTimeout(reloadTimer)
      reloadTimer = null
    }
    watcher.close()
  })
}
