/**
 * Lazy overlay renderer lifecycle with explicit readiness and latest-value
 * delivery. Creation/loading stays here; native-tree placement and destruction
 * are delegated to the host so one controller remains authoritative for the
 * window's child views. Manual readiness keeps a panel hidden until its
 * renderer has installed inbound subscriptions.
 */
import path from 'node:path'
import type { WebContents, WebContentsView as ElectronWebContentsView } from 'electron'

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
  /** Translate bounds / hidden into the host's placement system. */
  setDesired(bounds: OverlayPanelBounds | null): void
  /** Register this panel's (possibly not-yet-created) view with the host's
   *  reconciler exactly once, at construction. */
  registerView(getView: () => ElectronWebContentsView | null): void
  /** Prepare a detached renderer viewport before loading, when intrinsic layout needs it. */
  prepareView?(view: ElectronWebContentsView): void
  /** Detach and close through the host's single native-view owner. */
  destroyView(view: ElectronWebContentsView): void
  /** Push the latest `data` into the overlay renderer after it is ready. */
  pushData?(view: ElectronWebContentsView, data: TShowData): void
  /** `load` is sufficient for simple documents. `manual` requires the renderer
   *  to acknowledge that its subscriptions are installed via `markReady()`. */
  readyMode?: 'load' | 'manual'
}

export interface OverlayPanelBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface OverlayPanel<TShowData = void> {
  /** Create the renderer without making it visible, so transient UI can warm up. */
  prepare(): void
  /** Lazy-create (or reuse the live instance) and publish its desired bounds.
   *  `null` updates its data while keeping it hidden. */
  show(data: TShowData, bounds: OverlayPanelBounds | null): void
  /** Move/resize the already-shown panel (no-op if not currently shown). */
  reposition(bounds: OverlayPanelBounds): void
  /** Withdraw from the host's placement (`setDesired(null)`); the native view
   *  is kept alive for the next `show()`. */
  hide(): void
  isPresent(): boolean
  getWebContents(): WebContents | null
  getWebContentsId(): number | null
  /** Resolve once the current renderer has installed its subscriptions. */
  whenReady(): Promise<void>
  /** Accept a ready acknowledgement only from the current WebContents. */
  markReady(webContentsId: number): void
  /** Hard teardown through the host owner. The next `show()` creates a fresh instance. */
  destroy(): void
}

export function createOverlayPanel<TShowData = void>(
  deps: OverlayPanelDeps<TShowData>,
): OverlayPanel<TShowData> {
  let view: ElectronWebContentsView | null = null
  let ready = false
  let hasPendingData = false
  let latestData: TShowData
  let readyWaiters: Array<() => void> = []
  let instanceEpoch = 0
  let pendingBounds: OverlayPanelBounds | null = null
  let wantsVisible = false

  deps.registerView(() => view)

  function resolveReadyWaiters(): void {
    const waiters = readyWaiters
    readyWaiters = []
    for (const resolve of waiters) resolve()
  }

  function markCurrentReady(current: ElectronWebContentsView, epoch: number): void {
    if (view !== current || epoch !== instanceEpoch || current.webContents.isDestroyed()) return
    ready = true
    if (deps.pushData && hasPendingData) {
      hasPendingData = false
      deps.pushData(current, latestData)
    }
    if (deps.readyMode === 'manual' && wantsVisible && pendingBounds) deps.setDesired(pendingBounds)
    resolveReadyWaiters()
  }

  function ensureView(): ElectronWebContentsView {
    if (view && !view.webContents.isDestroyed()) return view
    if (view) deps.destroyView(view)
    view = null
    ready = false
    const created = deps.electron.createWebContentsView({ webPreferences: deps.webPreferences })
    const epoch = ++instanceEpoch
    deps.hardenNavigation?.(created.webContents)
    created.setBackgroundColor(deps.backgroundColor ?? '#00000000')
    view = created
    deps.prepareView?.(created)
    if ((deps.readyMode ?? 'load') === 'load') {
      created.webContents.once('did-finish-load', () => markCurrentReady(created, epoch))
    }
    void created.webContents.loadFile(path.join(deps.rendererDir, deps.entry))
    return created
  }

  return {
    prepare() {
      ensureView()
    },
    show(data, bounds) {
      const v = ensureView()
      pendingBounds = bounds
      wantsVisible = bounds !== null
      if ((deps.readyMode ?? 'load') === 'load' || ready || bounds === null) {
        deps.setDesired(bounds)
      }
      if (!deps.pushData) return
      latestData = data
      if (ready) {
        deps.pushData(v, data)
      } else {
        hasPendingData = true
      }
    },
    reposition(bounds) {
      if (!view) return
      pendingBounds = bounds
      wantsVisible = true
      if ((deps.readyMode ?? 'load') === 'load' || ready) deps.setDesired(bounds)
    },
    hide() {
      if (!view) return
      pendingBounds = null
      wantsVisible = false
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
    whenReady() {
      if (ready && view && !view.webContents.isDestroyed()) return Promise.resolve()
      return new Promise<void>((resolve) => readyWaiters.push(resolve))
    },
    markReady(webContentsId) {
      const current = view
      if (!current || current.webContents.id !== webContentsId) return
      markCurrentReady(current, instanceEpoch)
    },
    destroy() {
      const v = view
      if (!v) return
      view = null
      ready = false
      hasPendingData = false
      pendingBounds = null
      wantsVisible = false
      instanceEpoch++
      resolveReadyWaiters()
      deps.destroyView(v)
    },
  }
}
