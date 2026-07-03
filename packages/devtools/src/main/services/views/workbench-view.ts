import { nativeTheme, WebContentsView } from 'electron'
import { handleWindowOpenExternal } from '../../windows/navigation-hardening.js'
import { VIEW_ID } from '../../../shared/view-ids.js'
import { destroyChildView } from './destroy-child-view.js'
import type { PlacementReconciler } from './placement-reconciler.js'
import type { ViewManagerContext } from './view-manager.js'

/**
 * The opt-in VS Code workbench hosting the 'editor' dock slot. Lazily created
 * by `attachWorkbench` from the COI server URL; its bounds ride the renderer
 * 'editor'-slot anchor (forward anchor, like the simulator DevTools overlay).
 */
export interface WorkbenchView {
  attachWorkbench(url: string): Promise<void>
  setWorkbenchSource(url: string): void
  detachWorkbench(): void
  openFileInWorkbench(relPath: string, line: number, column: number): boolean
}

export function createWorkbenchView(
  ctx: ViewManagerContext,
  reconciler: PlacementReconciler,
): WorkbenchView {
  let workbenchView: WebContentsView | null = null
  // Whether the devtools-theme → workbench-theme `nativeTheme` listener is live.
  // Bound lazily on first workbench attach, removed on detach.
  let workbenchThemeSyncBound = false
  // COI server base URL for the workbench, stored by `setWorkbenchSource`. The
  // heavy WebContentsView load is deferred until the 'editor' slot first becomes
  // visible (first non-zero `setWorkbenchBounds`) so it never sits on the app
  // boot critical path (which would delay preload/window-ready and trip the e2e
  // health check into a relaunch).
  let workbenchUrl: string | null = null

  /** Current devtools color scheme, mirrored into the workbench's theme. */
  function workbenchThemeScheme(): 'light' | 'dark' {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  }

  // Push the live devtools scheme into the workbench whenever it flips. The
  // workbench is a plain isolated http document, so drive its exposed
  // `__WB_SET_THEME` setter over executeJavaScript (mirrors openFileInWorkbench).
  // The setter only exists once the workbench's configuration service is
  // initialized; before then the URL-query initial value already covers the
  // current scheme, and a missing setter here is a tolerated no-op.
  function pushWorkbenchTheme(): void {
    if (!workbenchView || workbenchView.webContents.isDestroyed()) return
    const wc = workbenchView.webContents
    if (typeof wc.executeJavaScript !== 'function') return
    const script = `window.__WB_SET_THEME && window.__WB_SET_THEME(${JSON.stringify(workbenchThemeScheme())})`
    wc.executeJavaScript(script, true).catch(() => { /* workbench not yet ready */ })
  }

  async function attachWorkbench(url: string): Promise<void> {
    if (workbenchView) return
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
      },
    })
    workbenchView = view
    // Track devtools theme flips for the lifetime of the workbench view only —
    // registered here (not at construction) so test electron mocks that omit
    // `nativeTheme` and never open the editor stay unaffected. Removed in
    // detachWorkbench.
    if (!workbenchThemeSyncBound) {
      nativeTheme.on('updated', pushWorkbenchTheme)
      workbenchThemeSyncBound = true
    }
    // The workbench bundle loads arbitrary URLs (docs links, etc.); route popups
    // + cross-origin in-place navigation to the OS browser (mirror the host
    // toolbar / native simulator hardening).
    try {
      view.webContents.setWindowOpenHandler(({ url: target }) => handleWindowOpenExternal(target))
    } catch { /* stub may lack it */ }
    ctx.windows.mainWindow.contentView.addChildView(view)
    // Hand the workbench the current devtools scheme as a URL query so its very
    // first paint already matches (the runtime setter only exists post-init).
    const loadUrl = `${url}index.html?theme=${workbenchThemeScheme()}`
    await view.webContents.loadURL(loadUrl).catch((err) => {
      console.error('[workbench] attachWorkbench — loadURL failed', err)
    })
  }

  /** Store the COI base URL; the heavy load happens lazily on first show. */
  function setWorkbenchSource(url: string): void {
    workbenchUrl = url
  }

  function detachWorkbench(): void {
    if (workbenchThemeSyncBound) {
      nativeTheme.removeListener('updated', pushWorkbenchTheme)
      workbenchThemeSyncBound = false
    }
    destroyChildView(ctx.windows.mainWindow, workbenchView)
    workbenchView = null
    reconciler.deleteBaseDesired(VIEW_ID.workbench)
    reconciler.reconcileNow()
  }

  // Build the `file:///workspace/<rel>` URI string with each path SEGMENT
  // percent-encoded. A raw `rel` passed to `vscode.Uri.parse` mis-parses a
  // filename containing `#` (treated as a fragment) or `?` (treated as a
  // query), opening the wrong document; encoding each segment (but not the
  // `/` separators) keeps the path structure while escaping the reserved
  // characters. Leading slashes are already stripped by the caller.
  function workspaceUriFor(rel: string): string {
    const encoded = rel.split('/').map(encodeURIComponent).join('/')
    return `file:///workspace/${encoded}`
  }

  // Single attempt to reveal `uri` at the 0-based position in the workbench.
  // Resolves false when `__WB_PROBE` is not yet exposed (the workbench's
  // configuration service has not initialized) OR the open throws, so the
  // caller can retry; true once the document is shown.
  function tryRevealInWorkbench(uri: string, zeroLine: number, zeroCol: number): Promise<boolean> {
    if (!workbenchView || workbenchView.webContents.isDestroyed()) {
      return Promise.resolve(false)
    }
    const script = `(async () => {
      try {
        const P = window.__WB_PROBE; if (!P) return false
        const vscode = P.vscode
        const uri = vscode.Uri.parse(${JSON.stringify(uri)})
        const doc = await vscode.workspace.openTextDocument(uri)
        const pos = new vscode.Position(${zeroLine}, ${zeroCol})
        await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) })
        return true
      } catch (e) { return false }
    })()`
    return workbenchView.webContents
      .executeJavaScript(script, true)
      .then((ok) => ok === true)
      .catch(() => false)
  }

  // Reveal a project file in the embedded workbench, awaiting the real open
  // result and retrying while the workbench finishes booting. The right-panel
  // console redirect (`onOpenUrl`) fires open-in-editor clicks that can land
  // during the workbench's lazy attach/boot window, when `__WB_PROBE` is not
  // yet exposed; without the retry the click is silently dropped (the inner
  // script returns false and the old code ignored it). Returns true only once
  // the document is actually shown; false when there is no workbench view or
  // every attempt failed.
  function openFileInWorkbench(relPath: string, line: number, column: number): boolean {
    if (!workbenchView || workbenchView.webContents.isDestroyed()) return false
    // The workbench mirrors the active project under file:///workspace/<rel>; the
    // open-in-editor target is 1-based (editor convention) while vscode.Position
    // is 0-based, so clamp-convert. Drive the workbench's own vscode API rather
    // than a preload bridge — the bundle is a plain isolated http document.
    const uri = workspaceUriFor(relPath.replace(/^\/+/, ''))
    const zeroLine = Math.max(0, Math.floor(line) - 1)
    const zeroCol = Math.max(0, Math.floor(column) - 1)
    void (async () => {
      // Poll for workbench readiness: ~10 attempts × 150ms ≈ 1.5s, covering the
      // first lazy attach + ext-host boot. Each attempt re-checks the live view
      // so a teardown mid-retry bails cleanly.
      for (let attempt = 0; attempt < 10; attempt++) {
        if (!workbenchView || workbenchView.webContents.isDestroyed()) return
        if (await tryRevealInWorkbench(uri, zeroLine, zeroCol)) return
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      console.error('[workbench] openFileInWorkbench: workbench never became ready for', uri)
    })()
    return true
  }

  // workbench is gated until it has a source or a live view (it lazy-creates
  // from the URL in the attach op).
  reconciler.registerView(VIEW_ID.workbench, {
    getView: () => workbenchView,
    gateHidden: () => !workbenchView && !workbenchUrl,
    beforeAttach: () => {
      if (!workbenchView && workbenchUrl) {
        // Lazy-load the workbench; attachWorkbench adds it to the contentView.
        void attachWorkbench(workbenchUrl)
        return true
      }
      return false
    },
    ensureLazy: (desired) => {
      if (desired?.placement.visible && !workbenchView && workbenchUrl) void attachWorkbench(workbenchUrl)
    },
  })

  return { attachWorkbench, setWorkbenchSource, detachWorkbench, openFileInWorkbench }
}
