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
 * `installCustomApisBridge` in `src/preload/runtime/custom-apis.ts`) reaches
 * the host without being white-listed here:
 *  - default `<webview>` path: proxied through the trusted main-window renderer
 *    via `ipcRenderer.sendToHost` + `<webview>.send`;
 *  - native-host path (top-level WebContentsView, no embedder): dispatched by a
 *    `ctx.simulatorApis`-backed `ipcMain.on` listener bound to that exact simWc
 *    in view-manager `attachNativeCustomApiBridge` — it gates on the precise
 *    sender id rather than this white-list.
 * Keeping the guest off this list contains the blast radius if the
 * simulator content is ever compromised.
 *
 * Host-owned BrowserWindows registered via `instance.registerTrustedWindow`
 * are additionally accepted via `ctx.trustedWindowSenderIds`.
 *
 * Any other sender — including a stale/destroyed sender or an unknown
 * iframe — is rejected.
 */
export function createWorkbenchSenderPolicy(
  ctx: Pick<WorkbenchContext, 'windows' | 'views' | 'trustedWindowSenderIds'>,
): SenderPolicy {
  return (sender: WebContents) => {
    if (sender.isDestroyed()) return false

    // Main window renderer
    if (ctx.windows.isMainSender(sender.id)) return true

    // Standalone settings BrowserWindow renderer
    if (ctx.windows.isSettingsWindowSender(sender.id)) return true

    // Host-registered trusted windows (registerTrustedWindow)
    if (ctx.trustedWindowSenderIds.has(sender.id)) return true

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
