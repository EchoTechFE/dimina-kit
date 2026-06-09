import { BrowserWindow, nativeTheme } from 'electron'
import { toDisposable, type Disposable } from '@dimina-kit/electron-deck/main'

/**
 * Background color that matches the current system color scheme.
 * Pass as `backgroundColor` when creating BrowserWindows to prevent
 * a white or black flash before the renderer CSS loads.
 *
 * Dark:  hsl(0 0% 10%) ≈ #1a1a1a  (--color-bg)
 * Light: hsl(0 0% 98%) ≈ #fafafa  (--color-bg)
 */
export function themeBg(): string {
  return nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#fafafa'
}

/**
 * Install a single process-wide listener that keeps every window's native
 * `backgroundColor` in sync with the active color scheme.
 *
 * A window's `backgroundColor` is otherwise frozen at the value passed to its
 * constructor: after a theme switch the stale color bleeds through wherever
 * native chrome and the WebContents meet. On Windows/Linux (in-window menu
 * bar) it shows as a light hairline between the menu bar and the page; on
 * macOS (global menu bar) it is latent — only a wrong-color flash on resize.
 * The defect is platform-agnostic, so the fix is too: one `nativeTheme`
 * `updated` listener re-syncs every current and future BrowserWindow.
 *
 * Known limitation: on Linux the `updated` event does not fire for OS-level
 * system theme changes (electron/electron#25925) — only for explicit
 * `nativeTheme.themeSource` assignments. In-app theme switches go through
 * `applyTheme()` and are unaffected on every platform; the gap is limited to
 * Linux + `theme: 'system'` + an OS theme change, an upstream Electron
 * limitation that also leaves the renderer's `prefers-color-scheme` stale.
 *
 * Returns a Disposable that detaches the listener. Install it once during
 * app setup and hand the Disposable to the workbench registry.
 */
export function installThemeBackgroundSync(): Disposable {
  const apply = () => {
    const bg = themeBg()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.setBackgroundColor(bg)
      }
    }
  }
  nativeTheme.on('updated', apply)
  return toDisposable(() => {
    nativeTheme.removeListener('updated', apply)
  })
}
