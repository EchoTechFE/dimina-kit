/**
 * Whether a `BrowserWindow` hosts a given `webContents`, across every shape a
 * simulator/render surface can take: a `<webview>` guest (its embedder is
 * reported through `hostWebContents`, which is itself either the window's own
 * renderer or one of its WebContentsViews), or a native-host WebContentsView
 * hanging directly off the window's `contentView` tree.
 *
 * Two independent call sites need this exact judgment — a per-window IPC
 * router resolving which window a message belongs to, and a per-window
 * storage-panel scan filtering process-global webContents events down to its
 * own window — so it lives here as the single owner of the rule.
 */
import type { BrowserWindow, View, WebContents } from 'electron'

function viewHostsWebContents(view: View | undefined, wcId: number): boolean {
  if (!view) return false
  const own = (view as { webContents?: WebContents }).webContents
  if (own && !own.isDestroyed() && own.id === wcId) return true
  for (const child of view.children ?? []) {
    if (viewHostsWebContents(child, wcId)) return true
  }
  return false
}

/** Whether `win` hosts `wc`, per the judgment above. */
export function windowHostsWebContents(win: BrowserWindow | undefined, wc: WebContents): boolean {
  if (!win || win.isDestroyed() || wc.isDestroyed()) return false
  const windowWc = win.webContents
  const hostsDirectly = (id: number): boolean =>
    (!!windowWc && !windowWc.isDestroyed() && windowWc.id === id)
    || viewHostsWebContents(win.contentView, id)
  if (hostsDirectly(wc.id)) return true
  const host = (wc as { hostWebContents?: WebContents }).hostWebContents
  return !!host && !host.isDestroyed() && hostsDirectly(host.id)
}
