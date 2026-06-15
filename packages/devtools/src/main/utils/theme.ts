import { BrowserWindow, nativeTheme } from 'electron'
import { toDisposable, type Disposable } from '@dimina-kit/electron-deck/main'
import { WorkbenchSettingsChannel } from '../../shared/ipc-channels.js'

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
 * Backdrop ("desk") color for the native simulator WebContentsView — the
 * surface the simulated phone sits on. Unlike {@link themeBg} (the window bg),
 * the desk is a neutral grey kept a touch off the window so the light-colored
 * phone keeps contrast against it in BOTH schemes.
 *
 * Dark:  hsl(0 0% 7%)  ≈ #121212  (the long-standing desk color — unchanged)
 * Light: hsl(0 0% 91%) ≈ #e8e8e8  (neutral grey; the white phone reads on it)
 *
 * MUST stay equal to the renderer's `--color-sim-bg` (design.css) and the
 * simulator page's `.device-shell-root` background (device-shell.css): the WCV,
 * the desk, and the placeholder behind it are the same color so a height-resize
 * never flashes a mismatched strip. Update all three together.
 */
export function simDeskBg(): string {
  return nativeTheme.shouldUseDarkColors ? '#121212' : '#e8e8e8'
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
    const isDark = nativeTheme.shouldUseDarkColors
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      // Isolate each window: a window closing mid-loop (or a renderer torn down
      // between the isDestroyed() check and the send) must not abort the sync
      // for the remaining windows.
      try {
        win.setBackgroundColor(bg)
        // Notify renderer JS consumers that can't observe the CSS
        // `prefers-color-scheme` change (Monaco's theme). Electron does not
        // dispatch the renderer's matchMedia change event for programmatic
        // `nativeTheme.themeSource` flips, so push it from here — the one place
        // that already centralizes color-scheme reactions.
        if (!win.webContents.isDestroyed()) {
          win.webContents.send(WorkbenchSettingsChannel.ThemeChanged, isDark)
        }
      } catch { /* window/webContents gone mid-loop */ }
    }
  }
  nativeTheme.on('updated', apply)
  return toDisposable(() => {
    nativeTheme.removeListener('updated', apply)
  })
}
