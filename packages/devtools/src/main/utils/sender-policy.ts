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
 * The simulator webview is intentionally NOT on this list. Anything it
 * needs from main (currently just the custom-apis bridge — see
 * `installCustomApisBridge` in `src/preload/runtime/custom-apis.ts` and the
 * matching `useCustomApiProxy` host hook) proxies through the trusted
 * main-window renderer via `ipcRenderer.sendToHost` + `<webview>.send`.
 * Keeping the guest off this list contains the blast radius if the
 * simulator content is ever compromised.
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

    // simulator <webview> proxies through main-window renderer (see file header).

    return false
  }
}
