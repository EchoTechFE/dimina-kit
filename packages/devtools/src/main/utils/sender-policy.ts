import type { WebContents } from 'electron'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
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
 * the host without being white-listed here via the native-host path:
 * the simulator is a top-level WebContentsView (no embedder), and its
 * custom-api traffic is dispatched by a `ctx.simulatorApis`-backed
 * `ipcMain.on` listener bound to that exact simWc in view-manager
 * `attachNativeCustomApiBridge` — it gates on the precise sender id rather
 * than this white-list. (Historically a `<webview>` simulator proxied through
 * the trusted main-window renderer via `ipcRenderer.sendToHost` + `<webview>.send`;
 * that renderer-proxied path no longer exists — native-host is the sole runtime.)
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

    // The host-toolbar overlay is DELIBERATELY NOT trusted here. The host loads
    // arbitrary content into it, so granting it the global white-list would open
    // all ~72 IpcRegistry channels to that content. Its one channel (the reverse
    // size-advertiser) is instead a raw `ipcMain.on` gated on its exact wc id in
    // `registerViewsIpc` — same blast-radius containment as the simulator guest.

    // The simulator (a top-level WebContentsView under native-host) is also
    // DELIBERATELY off this white-list; its custom-api traffic is gated on the
    // exact simWc id elsewhere (see file header). There is no longer a
    // renderer-proxied <webview> simulator path.

    return false
  }
}
