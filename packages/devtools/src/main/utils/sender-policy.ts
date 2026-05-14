import type { WebContents } from 'electron'
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { SenderPolicy } from './ipc-registry.js'

/**
 * Default workbench sender white-list.
 *
 * An IPC message is accepted only when its `event.sender` matches one of
 * the WebContents the main process itself created and trusts:
 * - the main window's renderer
 * - the optional workbench settings BrowserWindow's renderer (when open)
 * - the settings overlay view (when open)
 * - the popover overlay view (when open)
 *
 * The simulator webview is intentionally NOT on this list: its preload
 * (`src/preload/windows/simulator.ts`) uses `ipcRenderer.sendToHost`
 * exclusively, never `invoke`/`send`, so it can't legitimately reach an
 * ipcMain handler. Including it would only widen the attack surface if
 * the guest were ever compromised.
 *
 * Any other sender — including a stale/destroyed sender or an unknown
 * iframe — is rejected.
 */
export function createWorkbenchSenderPolicy(
  ctx: Pick<WorkbenchContext, 'windows' | 'views'>,
): SenderPolicy {
  return (sender: WebContents) => {
    if (sender.isDestroyed()) return false

    // Main window renderer
    if (ctx.windows.isMainSender(sender.id)) return true

    // Standalone settings BrowserWindow renderer
    if (ctx.windows.isSettingsWindowSender(sender.id)) return true

    // Settings overlay view (mounted inside the main window)
    const settingsViewId = ctx.views.getSettingsWebContentsId()
    if (settingsViewId != null && sender.id === settingsViewId) return true

    // Popover overlay view
    const popoverViewId = ctx.views.getPopoverWebContentsId()
    if (popoverViewId != null && sender.id === popoverViewId) return true

    // simulator preload uses sendToHost only; never reaches ipcMain handlers.

    return false
  }
}
