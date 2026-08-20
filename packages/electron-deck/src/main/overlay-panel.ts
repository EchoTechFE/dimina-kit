/**
 * `OverlayPanel` — the lazy-create/reuse/destroy lifecycle every main-owned
 * `WebContentsView` overlay (a settings sheet, a popover, a tooltip — anything
 * a host wants to load once and show/hide/reposition many times) was
 * hand-rolling per call site before this existed: construct with fixed
 * `webPreferences`, apply the host's own navigation policy, force a
 * transparent background, `loadFile` the overlay's renderer entry, and only
 * push data into it once that load actually lands (`did-finish-load`) — vs.
 * immediately, on every later `show()` while the same instance survives.
 *
 * This module owns ONLY that native-view lifecycle. It deliberately does NOT
 * own z-order or placement — a host with its own reconciler (zones/layers,
 * desired-state diffing) keeps that authority; folding it in here would give
 * two independent systems (this one and the host's) authority over the same
 * `contentView`, which is how views go missing or fight for top. `setDesired`
 * is the injected seam: the host translates "here are the bounds" (or "hide")
 * into whatever its own placement system does with that.
 *
 * Reuse model: a panel that wants "fresh instance every open" (no state
 * carried between opens) calls `destroy()` immediately before its next
 * `show()` — two calls, no separate mode flag on this API.
 */
import path from 'node:path'
import type { BrowserWindow, WebContents, WebContentsView as ElectronWebContentsView } from 'electron'

export interface OverlayPanelWebPreferences {
  preload: string
  nodeIntegration?: boolean
  contextIsolation?: boolean
  sandbox?: boolean
}

/**
 * The one Electron capability this module needs, injected so this file never
 * imports `'electron'` itself (keeps `@dimina-kit/electron-deck/main`
 * importable from non-Electron test runners, matching `compositor.ts` /
 * `view-handle.ts`'s convention in this package). A FUNCTION, not `{
 * WebContentsView }`: a host that does `electron: { WebContentsView }` at
 * its own call site (reading the imported binding into an object literal
 * immediately) makes every consumer of `createOverlayPanel` eagerly resolve
 * `WebContentsView` at CONSTRUCTION time — which broke every test that
 * builds a host context without mocking that export, even ones that never
 * show a panel. A function value defers the read until the LAZY `show()`
 * path actually calls it.
 */
export interface OverlayPanelElectron {
  createWebContentsView(opts: { webPreferences: OverlayPanelWebPreferences }): ElectronWebContentsView
}

export interface OverlayPanelDeps<TShowData> {
  electron: OverlayPanelElectron
  /** Absolute path to the compiled renderer's root dir (e.g. `…/dist/renderer`). */
  rendererDir: string
  /** Entry HTML relative to `rendererDir`, e.g. `'entries/tooltip/index.html'`. */
  entry: string
  webPreferences: OverlayPanelWebPreferences
  /** The host's own navigation/security policy, applied once per fresh view,
   *  before it loads anything. */
  hardenNavigation?(webContents: WebContents): void
  /** CSS color string; defaults to fully transparent (`#00000000`). */
  backgroundColor?: string
  /** Translate "these bounds" / `null` ("hidden") into the host's own
   *  placement system (mount + setBounds, or unmount). Called on every
   *  `show()`/`reposition()`/`hide()`. */
  setDesired(bounds: OverlayPanelBounds | null): void
  /** Register this panel's (possibly not-yet-created) view with the host's
   *  reconciler exactly once, at construction. */
  registerView(getView: () => ElectronWebContentsView | null): void
  /** Push `data` into the overlay's own renderer: on first creation, once its
   *  `did-finish-load` actually lands (an IPC sent before that would be lost);
   *  on every later `show()` while the same instance is reused, immediately
   *  (the renderer is already alive and already subscribed). */
  pushData?(view: ElectronWebContentsView, data: TShowData): void
}

export interface OverlayPanelBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface OverlayPanel<TShowData = void> {
  /** Lazy-create (or reuse the live instance) and show at `bounds`. */
  show(data: TShowData, bounds: OverlayPanelBounds): void
  /** Move/resize the already-shown panel (no-op if not currently shown). */
  reposition(bounds: OverlayPanelBounds): void
  /** Withdraw from the host's placement (`setDesired(null)`); the native view
   *  is kept alive for the next `show()`. */
  hide(): void
  isPresent(): boolean
  getWebContents(): WebContents | null
  getWebContentsId(): number | null
  /** Hard teardown: detach from `mainWindow` and close the native view. The
   *  next `show()` creates a brand-new instance (fresh load, no state). */
  destroy(mainWindow: BrowserWindow): void
}

export function createOverlayPanel<TShowData = void>(
  deps: OverlayPanelDeps<TShowData>,
): OverlayPanel<TShowData> {
  let view: ElectronWebContentsView | null = null

  deps.registerView(() => view)

  function ensureView(): { view: ElectronWebContentsView; freshlyCreated: boolean } {
    if (view) return { view, freshlyCreated: false }
    const created = deps.electron.createWebContentsView({ webPreferences: deps.webPreferences })
    deps.hardenNavigation?.(created.webContents)
    created.setBackgroundColor(deps.backgroundColor ?? '#00000000')
    view = created
    created.webContents.loadFile(path.join(deps.rendererDir, deps.entry))
    return { view: created, freshlyCreated: true }
  }

  return {
    show(data, bounds) {
      const { view: v, freshlyCreated } = ensureView()
      deps.setDesired(bounds)
      if (!deps.pushData) return
      if (freshlyCreated) {
        v.webContents.once('did-finish-load', () => deps.pushData?.(v, data))
      } else {
        deps.pushData(v, data)
      }
    },
    reposition(bounds) {
      if (!view) return
      deps.setDesired(bounds)
    },
    hide() {
      if (!view) return
      deps.setDesired(null)
    },
    isPresent() {
      return view !== null
    },
    getWebContents() {
      if (!view || view.webContents.isDestroyed()) return null
      return view.webContents
    },
    getWebContentsId() {
      if (!view || view.webContents.isDestroyed()) return null
      return view.webContents.id
    },
    destroy(mainWindow) {
      const v = view
      if (!v) return
      view = null
      if (!mainWindow.isDestroyed()) {
        try {
          mainWindow.contentView.removeChildView(v)
        } catch { /* already removed */ }
      }
      try {
        if (!v.webContents.isDestroyed()) v.webContents.close()
      } catch { /* ignore */ }
    },
  }
}
