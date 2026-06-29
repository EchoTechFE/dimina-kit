import type { IpcMainEvent, WebContents } from 'electron'
import { ipcMain, nativeTheme, shell, WebContentsView, webContents } from 'electron'
import fs from 'node:fs'
import path from 'path'
import { cjsSiblingPreloadPath, mainPreloadPath } from '../../utils/paths.js'
import { simDeskBg } from '../../utils/theme.js'
import {
  applyNavigationHardening,
  handleWindowOpenExternal,
} from '../../windows/navigation-hardening.js'
import type { RenderEvent } from '../../ipc/bridge-router.js'
import { SimulatorCustomApiBridgeChannel } from '../../../shared/ipc-channels.js'
import type { NativeDeviceInfo } from '../../../shared/ipc-channels.js'
import {
  buildDevtoolsProjectSourceLinksScript,
  decodeOpenInEditorUrl,
  type OpenInEditorRequest,
  projectSourceContextFromServiceHostUrl,
  resourceUrlToProjectRelativePath,
} from '../../../shared/open-in-editor.js'
import { createSafeAreaController } from '../safe-area/index.js'
import { buildCustomizeTabsScript } from './devtools-tabs.js'
import { installElementsForward } from '../elements-forward/index.js'
import { installServiceConsoleForward } from '../service-console/index.js'
import * as layout from '../layout/index.js'
import {
  handleCustomApiBridgeRequest,
  type CustomApiBridgeRequest,
} from '../simulator/custom-apis.js'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import { type WorkbenchContext } from '../workbench-context.js'
import { configureMiniappSession, miniappPartition } from './miniapp-partition.js'
import {
  acquireHostToolbarSessionRuntime,
  releaseHostToolbarSessionRuntime,
} from './host-toolbar-session-runtime.js'
import {
  createHostToolbarPortChannel,
  type HostToolbarMessageSubscription,
} from './host-toolbar-port-channel.js'
import { parseRoute } from '../../../shared/simulator-route.js'
import { HEADER_H, HOST_TOOLBAR_RUNTIME_MARKER } from '../../../shared/constants.js'

/**
 * Context surface used by the ViewManager. We only need a small slice of the
 * full WorkbenchContext here; typing it this way documents the actual dependency.
 */
export interface ViewManagerContext {
  windows: WorkbenchContext['windows']
  rendererDir: string
  /**
   * Per-webContents connection registry (foundation.md §4). The native-host
   * simulator WebContentsView is acquired here so the registry tracks that
   * trusted webContents and tears its per-wc resources (the custom-api bridge
   * `ipcMain.on`) down deterministically on destroy — see P1 DoD #3. Required:
   * `createWorkbenchContext` always supplies it.
   */
  connections: WorkbenchContext['connections']
  /** Active project root used to validate/open console source locations. */
  workspace?: WorkbenchContext['workspace']
  /**
   * Absolute path to the simulator preload bundle. Only consumed by the
   * native-host simulator WebContentsView (`attachNativeSimulator`); the
   * default `<webview>` path gets its preload from the session-registered
   * frame preload instead. Optional so partial test contexts compile.
   */
  preloadPath?: string
  notify: WorkbenchContext['notify']
  bridge?: WorkbenchContext['bridge']
  /**
   * Native-host network forwarder. `attachNativeSimulator` hands it the freshly
   * created simulator WebContentsView (`networkForward.attachSimulator`) so it can attach the
   * CDP debugger, and the DevTools front-end host wc (`setDevtoolsHost`) so it can
   * inject that WCV's Network.* events into the native Network tab (service-host
   * console line is the fallback). Optional so partial test contexts compile.
   */
  networkForward?: WorkbenchContext['networkForward']
  /**
   * Always-on console fan-out (set by `installBridgeRouter`). The service-console
   * capture feeds service-layer `consoleAPICalled` entries here so they reach
   * automation; mirrors how render entries arrive via the bridge. Optional so
   * partial test contexts compile.
   */
  consoleForwarder?: WorkbenchContext['consoleForwarder']
  /**
   * Per-context registry of host-registered simulator custom APIs. The
   * native-host simulator is a top-level WebContentsView with no embedder
   * renderer, so `attachNativeSimulator` dispatches the simulator-side
   * `__diminaCustomApis` bridge straight to this registry (the default
   * `<webview>` path proxies through the trusted main renderer instead).
   * Optional so partial test contexts compile.
   */
  simulatorApis?: WorkbenchContext['simulatorApis']
}

/**
 * Unified lifecycle manager for Electron WebContentsView overlays.
 *
 * Owns creation / attachment / detachment / positioning / destruction of
 * every overlay view hung off the main window's contentView (simulator
 * DevTools, settings, popover). All `new WebContentsView`, `addChildView`,
 * `removeChildView`, `webContents.destroy()` and overlay `setBounds` calls
 * should live here — IPC handlers just call into the manager.
 *
 * The code editor IS an overlay: the embedded VS Code workbench is a
 * main-process WebContentsView (`attachWorkbench`) hung off the main window's
 * contentView, like the other overlays. The main window's own renderer is the
 * content root and is not managed here.
 */
export interface ViewManager {
  // ── DevTools ───────────────────────────────────────────────────────────
  /**
   * NATIVE-HOST ONLY. Create the simulator itself as a top-level
   * WebContentsView (not a renderer `<webview>` guest) loading `simulatorUrl`,
   * and treat its webContents as THE simulator webContents (so
   * `getSimulatorWebContents` resolves it and the spawn/SIMULATOR_EVENTS
   * pipeline flows through it). This is required because Electron
   * force-disables the `<webview>` tag inside a webview guest, so a
   * `<webview>`-in-`<webview>` topology can never host DeviceShell's
   * per-page render-host `<webview>`s. A top-level WebContentsView's webContents
   * is NOT a guest and CAN host them. Then wires the DevTools/console view on
   * top of it via `attachNativeSimulatorDevtoolsHost`. Neither view is added
   * to the contentView here — both mount only when the renderer's view anchors
   * publish a non-zero rect (`setNativeSimulatorViewBounds` /
   * `setSimulatorDevtoolsBounds`). No-op (logs) when `preloadPath` is unset.
   * `simWidth` rides the wire for schema compatibility but is unused: all
   * geometry is anchor-published.
   */
  attachNativeSimulator(simulatorUrl: string, simWidth: number): Promise<void>
  /**
   * Destroy and null out the simulator view (e.g. on simulator detach).
   * Also destroys the cached settings view and hides the popover —
   * preserves the aggregate `detachAllViews` behaviour of the previous
   * `windows/views.ts` module, which every detach call relied on.
   */
  detachSimulator(): void

  // ── Settings (overlay panel on the right) ──────────────────────────────
  /** Lazy-create and show the settings overlay view. */
  showSettings(): Promise<void>
  /** Remove the settings overlay view (kept around for next open). */
  hideSettings(): void

  // ── Popover ────────────────────────────────────────────────────────────
  /** Create and show the popover overlay with the given init payload. */
  showPopover(data: unknown): void
  /** Destroy the popover overlay and notify the renderer. */
  hidePopover(): void

  // ── Aggregate ──────────────────────────────────────────────────────────
  /** Re-apply layout for every currently visible overlay (on window resize). */
  repositionAll(): void
  /** Destroy all overlay webContents and null out the cached views. */
  disposeAll(): void

  // ── State queries ─────────────────────────────────────────────────────
  /** Return the webContents ID of the currently attached simulator. */
  getSimulatorWebContentsId(): number | null
  /** Return the live webContents of the currently attached simulator, or null. */
  getSimulatorWebContents(): WebContents | null
  /** Return the active project path bound to the current native simulator. */
  getSimulatorProjectPath(): string | null
  /** Return the settings overlay's WebContents (for renderer-notifier). */
  getSettingsWebContents(): WebContents | null
  /** Return the webContents ID of the settings overlay if alive, else null. */
  getSettingsWebContentsId(): number | null
  /** Return the webContents ID of the popover overlay if alive, else null. */
  getPopoverWebContentsId(): number | null
  /**
   * Return the webContents ID of the host-toolbar overlay if alive, else null.
   * The host-toolbar WCV is the one overlay whose OWN renderer drives an IPC
   * channel back to main (the reverse size-advertiser), so the sender policy
   * must trust its id — see `createWorkbenchSenderPolicy`.
   */
  getHostToolbarWebContentsId(): number | null
  /**
   * Return the last host-toolbar height NOTIFIED to the main-window renderer
   * (an advertiser report in `'auto'` mode, a `setHeightMode({ fixed })` pin,
   * or 0 after `hostToolbar.hide()`); 0 before any notify. The renderer pulls
   * this on project-view mount to REPLAY a height whose push it missed — the
   * toolbar's size-advertiser deduplicates and never re-reports, so a notify
   * fired while no project view is mounted (cold start on the project list;
   * always on close-project → reopen) would otherwise be lost forever.
   */
  getHostToolbarHeight(): number

  // ── Compound operations (used by IPC handlers) ────────────────────────
  /**
   * NATIVE-HOST ONLY. Position the simulator content WebContentsView over the
   * renderer-measured simulator panel REGION rect (the flex:1 placeholder slot,
   * CSS px from the main window content top-left, which maps 1:1 to overlay
   * setBounds DIP) and apply the device zoom. The WCV fills the region as a
   * plain rectangle; DeviceShell draws + scrolls the phone inside. No-op in the
   * default `<webview>` path (`nativeSimulatorView` is null). See
   * `computeNativeSimulatorViewParams`.
   */
  setNativeSimulatorViewBounds(params: { x: number; y: number; width: number; height: number; zoom: number }): void
  /**
   * NATIVE-HOST ONLY. Re-push the selected device's CSS `env(safe-area-inset-*)`
   * override to every attached render-host guest (on device change). New guests
   * pick it up automatically when they attach (`did-attach-webview`).
   */
  reapplySafeArea(device: NativeDeviceInfo | null): void
  /**
   * Window-resize entry point. Re-applies the settings overlay's bounds only.
   * Simulator + DevTools overlay geometry is anchor-published (the renderer's
   * ResizeObserver re-measures on the same resize), so no static re-apply here.
   */
  resize(simWidth: number): void

  // ── Renderer-driven overlay bounds ────────────────────────────────────
  /**
   * Apply a renderer-measured rectangle to the simulator's Chromium
   * DevTools overlay view. `{ width: 0, height: 0 }` is treated as "hide" —
   * the view is removed from the contentView but its WebContents is kept
   * alive so re-showing it doesn't re-pay the DevTools bootstrap.
   */
  setSimulatorDevtoolsBounds(bounds: { x: number; y: number; width: number; height: number }): void

  // ── Embedded workbench editor WebContentsView ──────────────────────
  /**
   * Lazily create the workbench WebContentsView, load `<url>index.html`, and
   * add it to the contentView. `url` is the COI server's base URL (trailing
   * slash), which serves the workbench bundle with the SharedArrayBuffer
   * isolation headers. Idempotent: a second call is a no-op.
   */
  attachWorkbench(url: string): Promise<void>
  /**
   * Store the workbench COI base URL without loading it. The heavy
   * WebContentsView load is deferred to the first visible
   * `setWorkbenchBounds`, keeping it off the app boot critical path.
   */
  setWorkbenchSource(url: string): void
  /**
   * Apply a renderer-measured rectangle to the workbench editor view. Mirrors
   * `setSimulatorDevtoolsBounds`: `{ width: 0, height: 0 }` is "hide" — the view
   * is removed from the contentView (kept under settings/popover when re-added)
   * but its WebContents stays alive. The first non-zero rect lazily creates +
   * loads the workbench (from the URL set by `setWorkbenchSource`).
   */
  setWorkbenchBounds(bounds: { x: number; y: number; width: number; height: number }): void
  /** Destroy the workbench editor view (teardown). No-op if never attached. */
  detachWorkbench(): void
  /**
   * Reveal a project file in the embedded workbench at a 1-based line/column
   * (the open-in-editor target coordinate convention). Drives the workbench's
   * own vscode API over its mirrored `file:///workspace/<rel>` tree. No-op when
   * the workbench editor is not attached (host opted out). Returns whether the
   * request was dispatched to the workbench.
   */
  openFileInWorkbench(relPath: string, line: number, column: number): boolean

  // ── Host-controllable toolbar WebContentsView ─────────────────────────
  /**
   * Apply a renderer-measured rectangle to the host-controllable toolbar
   * WebContentsView (the strip above the devtools header). Forward anchor,
   * mirroring `setSimulatorDevtoolsBounds`. `{ width: 0, height: 0 }` is
   * treated as "hide" — the view is removed from the contentView but its
   * WebContents (and the host's loaded content) stays alive. Lazily creates
   * the view on the first non-empty rect.
   */
  setHostToolbarBounds(bounds: { x: number; y: number; width: number; height: number }): void
  /**
   * Reverse size-advertiser sink: the toolbar WCV's own renderer advertises
   * its intrinsic content height (block-axis extent); we retain it as the
   * last-notified height (`getHostToolbarHeight`) and push it to the
   * main-window renderer so the placeholder div resizes (closing the
   * dynamic-height loop). Ignored ENTIRELY while a `{ fixed }` height mode is
   * pinned via `hostToolbar.setHeightMode` — dropped reports neither notify
   * nor touch the retained value (the session-resident advertiser always
   * runs, so its reports must not fight a host-pinned height).
   */
  setHostToolbarHeight(extent: number): void
  /**
   * Host-facing control surface for the toolbar WebContentsView. The downstream
   * host loads its own content into it (`loadURL` / `loadFile`) and fully drives
   * it. Lazily creates the underlying view on the first load call.
   */
  readonly hostToolbar: HostToolbarControl
}

/**
 * Height mode for the host-toolbar placeholder strip. `'auto'` (default): the
 * session-resident advertiser's reports drive the height. `{ fixed }`: the
 * host pins the height; advertiser reports are ignored until `'auto'` again.
 */
export type HostToolbarHeightMode = 'auto' | { fixed: number }

/**
 * The control object the downstream host uses to own the toolbar
 * WebContentsView. Lazily backed by the view-manager's `hostToolbarView`.
 */
export interface HostToolbarControl {
  /** Load a URL into the toolbar view (lazy-creates the view). */
  loadURL(url: string): Promise<void>
  /** Load a local file into the toolbar view (lazy-creates the view). */
  loadFile(path: string): Promise<void>
  /** The toolbar view's live WebContents, or null if not yet created/destroyed. */
  readonly webContents: WebContents | null
  /** Remove the toolbar view from the contentView and reset it (kept alive). */
  hide(): void
  /**
   * The HOST's own `webPreferences.preload` for the toolbar view (purely
   * additive). The framework's height-advertiser runtime does NOT ride
   * `webPreferences.preload` — it is session-resident (registered on
   * `session.defaultSession`, self-guarded by the `--dimina-host-toolbar`
   * marker + `isMainFrame`), so a host preload set here coexists with it and
   * never replaces it. Must be set before the view is (re)created (first
   * `loadURL`/`loadFile`, or the next one after the host closed the
   * webContents); `null` (default) means "no host preload" — it does not and
   * cannot restore any built-in preload.
   */
  setPreloadPath(path: string | null): void
  /**
   * Register a host-side handler for messages the toolbar PAGE sends via
   * `window.diminaHostToolbar.send(channel, payload)`. Control-level: may be
   * called before the view exists and survives page reloads / wc rebuilds
   * (each per-load MessagePort handshake re-attaches the registry to the new
   * port). Throws on an empty / non-string channel. `dispose()` detaches
   * (idempotent).
   */
  onMessage(
    channel: string,
    handler: (payload: unknown) => void,
  ): HostToolbarMessageSubscription
  /**
   * Observe handshake readiness — the push counterpart to polling `send()`
   * for `true`. Fires the handler once per load generation, exactly when
   * that load's MessagePort handshake completes; registering while the
   * channel is ALREADY ready fires once asynchronously on a microtask
   * (missed-signal race guard, re-validated at fire time). A reload /
   * re-handshake fires registered handlers again; a host-initiated
   * `loadURL`/`loadFile` invalidates readiness at initiation, so handlers
   * registered in that window wait for the NEW document's handshake.
   * `dispose()` detaches (idempotent); `disposeAll` sweeps everything.
   */
  onReady(handler: () => void): HostToolbarMessageSubscription
  /**
   * Post `{ channel, payload }` to the toolbar page (received via
   * `window.diminaHostToolbar.onMessage(channel, handler)`). Gated and
   * non-queueing: returns false — delivering nothing, creating no view —
   * while there is no live toolbar webContents, the current load's
   * MessagePort handshake hasn't completed, or a document-replacing
   * navigation is in flight (`loadURL`/`loadFile` was issued, or the page
   * itself started a main-frame cross-document navigation, and the new
   * document hasn't handshaked yet); true once the envelope went out.
   * No manual `getHostToolbarWebContentsId` gating needed: the false/true
   * result IS the readiness signal.
   */
  send(channel: string, payload: unknown): boolean
  /**
   * Pin or unpin the toolbar strip height. `{ fixed }` notifies the renderer
   * placeholder with that height immediately (so a preload-less/static toolbar
   * is visible without any advertiser report) and ignores subsequent advertiser
   * reports. `'auto'` (default) re-enables advertiser-driven height starting
   * from the NEXT report — it does not synthesize/replay a stale height.
   */
  setHeightMode(mode: HostToolbarHeightMode): void
}

export interface ProjectEditorTarget {
  path: string
  line?: number
  column?: number
}

/**
 * Resolve a DevTools source request against the service-host URL that created
 * the inspected app. Its pkgRoot is authoritative; the workspace is only a
 * stale-session consistency guard.
 */
export function resolveProjectEditorTarget(
  serviceHostUrl: string,
  activeProjectRoot: string | undefined,
  req: OpenInEditorRequest,
  isFile: (absolutePath: string) => boolean = (absolutePath) => fs.statSync(absolutePath).isFile(),
): ProjectEditorTarget | null {
  const sourceContext = projectSourceContextFromServiceHostUrl(
    serviceHostUrl,
    activeProjectRoot,
  )
  if (!sourceContext) return null
  const rel = resourceUrlToProjectRelativePath(req.url, sourceContext)
  if (!rel) return null
  const absolute = path.resolve(sourceContext.projectRoot, ...rel.split('/'))
  const fromRoot = path.relative(path.resolve(sourceContext.projectRoot), absolute)
  if (!fromRoot || fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) return null
  try {
    if (!isFile(absolute)) return null
  } catch {
    return null
  }
  return {
    path: rel,
    line: typeof req.line === 'number' ? req.line + 1 : undefined,
    column: typeof req.column === 'number' ? req.column + 1 : undefined,
  }
}

/**
 * Build a ViewManager bound to the given context. The returned object is the
 * only component allowed to instantiate or add/remove overlay WebContentsViews.
 *
 * All view-related mutable state lives inside this closure and is not exposed
 * on the context object.
 */
export function createViewManager(ctx: ViewManagerContext): ViewManager {
  // CSS env(safe-area-inset-*) simulation for render-host guests (per device).
  // Driven from did-attach-webview below; re-pushed on device change via
  // reapplySafeArea. Torn down in disposeAll.
  const safeArea = createSafeAreaController({ connections: ctx.connections })

  // ── Private mutable state ───────────────────────────────────────────────
  let simulatorView: WebContentsView | null = null
  let simulatorViewAdded = false
  // NATIVE-HOST ONLY: the simulator content WebContentsView (the DeviceShell
  // host). In the default path the simulator is a renderer `<webview>` and this
  // stays null. Positioned in the simulator panel region (left of the splitter)
  // while `simulatorView` above hosts its DevTools in the right panel region.
  let nativeSimulatorView: WebContentsView | null = null
  let nativeSimulatorViewAdded = false
  let nativeSimulatorProjectPath: string | null = null
  let settleNativeSimulatorReady: (() => void) | null = null
  // Model A: the renderer's measured inner-screen rect is the SOLE authority for
  // the native simulator WCV bounds (see docs/simulator-render-architecture.md).
  // Cache the last rect so a report that lands before attachNativeSimulator (the
  // project-open ordering) is not lost — attach replays it instead of using a
  // coarse panel-size fallback (which raced and caused the clip/surround flips).
  let lastRendererRect: { x: number; y: number; width: number; height: number; zoom: number } | null = null
  // NATIVE-HOST ONLY. The `ipcMain.on` listener that services the
  // `__diminaCustomApis` bridge for the current native simulator webContents
  // (see `attachNativeCustomApiBridge`). Tracked so we can remove it before
  // tearing down / re-attaching the view (otherwise listeners leak across
  // relaunch cycles).
  let nativeCustomApiBridgeHandler: ((event: IpcMainEvent, req: unknown) => void) | null = null
  // NATIVE-HOST ONLY. The current device zoom as a factor (zoomPercent/100),
  // last reported by the renderer via setNativeSimulatorViewBounds. Stored so
  // nested render-host `<webview>` guests attached AFTER a zoom change still
  // pick up the correct scale in `did-attach-webview`. Defaults to 1 (100%).
  let currentZoomFactor = 1
  let settingsView: WebContentsView | null = null
  let settingsViewAdded = false
  let popoverView: WebContentsView | null = null
  let simulatorWebContentsId: number | null = null
  // NATIVE-HOST ONLY. The webContents the right-panel Chrome DevTools front-end
  // currently inspects. We point it at the SERVICE HOST (logic layer) — the
  // hidden BrowserWindow where the mini-app's page code runs (`console.log`,
  // `wx.request`, Sources/Network(fetch) all live there). The UI/view layer
  // (Elements/Styles/WXML tree) is served separately by the native WXML panel +
  // render-guest highlight chain (`simulator-storage`/`simulator-wxml`), so a
  // single DevTools front-end is enough. The service window can be swapped on
  // respawn (pre-warm pool recycles it), so this is re-resolved fresh via
  // `ctx.bridge.getServiceWc()` and re-pointed on every render-side event.
  let nativeDevtoolsSourceWc: WebContents | null = null
  let unsubscribeNativeRenderEvents: (() => void) | null = null
  // Disposer for the Elements-forward feature (routes the front-end's Elements
  // CDP traffic at the active render guest). Installed in
  // `attachNativeSimulatorDevtoolsHost`, stopped on detach / host destroyed.
  let stopElementsForward: (() => void) | null = null
  // Disposer for the service-layer console capture (CDP `consoleAPICalled` on the
  // service host wc → console fan-out). Installed when the DevTools is pointed at
  // a service host, stopped when that source is closed / swapped.
  let stopServiceConsole: (() => void) | null = null
  let nativeDevtoolsRetryTimer: ReturnType<typeof setTimeout> | null = null
  let nativeDevtoolsRetryToken = 0

  // Renderer-driven overlay bounds for the simulator DevTools view — the SOLE
  // mount/geometry authority (no static-layout fallback). A zero-area
  // rectangle means "hide" — the overlay is removed from the contentView but
  // its WebContents stays alive.
  let simulatorBoundsOverride: layout.Bounds | null = null

  // ── Embedded workbench editor WebContentsView ────────────────────────
  // The opt-in VS Code workbench hosting the 'editor' dock slot. Lazily created
  // by `attachWorkbench` from the COI server URL; its bounds ride the renderer
  // 'editor'-slot anchor (forward anchor, like the simulator DevTools overlay).
  let workbenchView: WebContentsView | null = null
  let workbenchViewAdded = false
  // Whether the devtools-theme → workbench-theme `nativeTheme` listener is live.
  // Bound lazily on first workbench attach, removed on detach.
  let workbenchThemeSyncBound = false
  // COI server base URL for the workbench, stored by `setWorkbenchSource`. The
  // heavy WebContentsView load is deferred until the 'editor' slot first becomes
  // visible (first non-zero `setWorkbenchBounds`) so it never sits on the app
  // boot critical path (which would delay preload/window-ready and trip the e2e
  // health check into a relaunch).
  let workbenchUrl: string | null = null

  // ── Host-controllable toolbar WebContentsView ───────────────────────────
  // A strip above the devtools header that the downstream host loads its own
  // content into and fully controls. Bounds come from a renderer DOM anchor
  // (forward anchor, like the simulator DevTools overlay); its height is
  // dynamic via a reverse size-advertiser the toolbar's own renderer drives.
  let hostToolbarView: WebContentsView | null = null
  let hostToolbarPreloadOverride: string | null = null
  let hostToolbarViewAdded = false
  // Whether THIS manager holds a reference on the shared defaultSession
  // registration of the toolbar-runtime preload (see
  // host-toolbar-session-runtime.ts). Acquired on first toolbar need,
  // released exactly once in disposeAll — a manager that never used the
  // toolbar must not decrement a ref it never took.
  let hostToolbarRuntimeAcquired = false
  // Placeholder height authority: 'auto' = advertiser reports forward to the
  // renderer; { fixed } = host-pinned, advertiser reports are dropped.
  let hostToolbarHeightMode: HostToolbarHeightMode = 'auto'
  // Last toolbar height NOTIFIED to the main-window renderer — the replay
  // source behind `getHostToolbarHeight()`. Updated ONLY inside
  // `notifyHostToolbarHeight` so the retained value can never diverge from
  // what the renderer was told (an advertiser report dropped by a `{ fixed }`
  // pin must not pollute it, and a setHeightMode validation reject leaves it
  // untouched).
  let hostToolbarLastHeight = 0
  // Gated narrow channel to the toolbar PAGE (per-load MessagePort handshake;
  // see host-toolbar-port-channel.ts). Control-level registry — created with
  // the manager so onMessage() works before any toolbar view exists.
  const hostToolbarPort = createHostToolbarPortChannel({
    isCurrent: (wc) => liveHostToolbarWebContents() === wc,
  })

  // ── Internal helpers ────────────────────────────────────────────────────

  function destroyViewInternal(view: WebContentsView | null): void {
    if (!view) return
    if (!ctx.windows.mainWindow.isDestroyed()) {
      try {
        ctx.windows.mainWindow.contentView.removeChildView(view)
      } catch { /* already removed */ }
    }
    try {
      if (!view.webContents.isDestroyed()) {
        view.webContents.close()
      }
    } catch { /* ignore */ }
  }

  // Renderer publishes width/height = 0 to mean "hide overlay" — the
  // surrounding React panel is unmounted/collapsed. We keep the cached
  // value (so future republishes win over legacy layout) but remove the
  // child view from the contentView until a non-empty rect arrives.
  function isHidden(b: layout.Bounds): boolean {
    return b.width <= 0 || b.height <= 0
  }

  function setSimulatorDevtoolsBounds(bounds: layout.Bounds): void {
    simulatorBoundsOverride = bounds
    if (!simulatorView || simulatorView.webContents.isDestroyed()) return
    if (ctx.windows.mainWindow.isDestroyed()) return
    if (isHidden(bounds)) {
      if (simulatorViewAdded) {
        try {
          ctx.windows.mainWindow.contentView.removeChildView(simulatorView)
        } catch { /* already removed */ }
        simulatorViewAdded = false
      }
      return
    }
    if (!simulatorViewAdded) {
      ctx.windows.mainWindow.contentView.addChildView(simulatorView)
      simulatorViewAdded = true
      // Re-attaching this base overlay moved it to the top of the z-stack; keep
      // any open settings/popover above it.
      raiseTopOverlays()
    }
    simulatorView.setBounds(bounds)
  }

  // ── Embedded workbench editor WebContentsView ────────────────────────

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
    workbenchViewAdded = true
    // Keep settings/popover above the freshly-added base overlay.
    raiseTopOverlays()
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

  function setWorkbenchBounds(bounds: layout.Bounds): void {
    if (ctx.windows.mainWindow.isDestroyed()) return
    // Zero-area rect means "hide" — remove the child view but keep its
    // WebContents (and the workbench's loaded state) alive. Never triggers the
    // lazy load: a hidden slot must not pull the workbench onto screen.
    if (isHidden(bounds)) {
      if (workbenchView && workbenchViewAdded && !workbenchView.webContents.isDestroyed()) {
        try {
          ctx.windows.mainWindow.contentView.removeChildView(workbenchView)
        } catch { /* already removed */ }
        workbenchViewAdded = false
      }
      return
    }
    // First time the 'editor' slot becomes visible: lazily create + load the
    // workbench (off the boot critical path). attachWorkbench assigns
    // workbenchView + addChildView synchronously, so bounds apply immediately
    // while the bundle loads in the background.
    if (!workbenchView && workbenchUrl) {
      void attachWorkbench(workbenchUrl)
    }
    if (!workbenchView || workbenchView.webContents.isDestroyed()) return
    if (!workbenchViewAdded) {
      ctx.windows.mainWindow.contentView.addChildView(workbenchView)
      workbenchViewAdded = true
      // Re-attaching this base overlay moved it to the top of the z-stack; keep
      // any open settings/popover above it.
      raiseTopOverlays()
    }
    workbenchView.setBounds(bounds)
  }

  function detachWorkbench(): void {
    if (workbenchThemeSyncBound) {
      nativeTheme.removeListener('updated', pushWorkbenchTheme)
      workbenchThemeSyncBound = false
    }
    destroyViewInternal(workbenchView)
    workbenchView = null
    workbenchViewAdded = false
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

  // ── Host-controllable toolbar WebContentsView ───────────────────────────

  // The toolbar's webContents lifecycle belongs to the HOST, which may close
  // it out from under us (the documented rebuild path). In real Electron a
  // WebContentsView whose webContents was destroyed can report `webContents`
  // as undefined — not merely a destroyed handle — so every access must
  // tolerate BOTH (observed in the R1 e2e: `.isDestroyed()` on undefined threw
  // inside the control surface after the host closed the wc).
  function liveHostToolbarWebContents(): WebContents | null {
    const wc = hostToolbarView?.webContents as WebContents | undefined
    if (!wc || wc.isDestroyed()) return null
    return wc
  }

  // Lazily create the host-toolbar view. Mirrors `showSettings` for the
  // webPreferences shape and the native simulator for nav hardening +
  // background color (the host may load arbitrary URLs / content). Idempotent.
  function ensureHostToolbarView(): WebContentsView {
    if (hostToolbarView && liveHostToolbarWebContents()) {
      return hostToolbarView
    }
    // Rebuilding after the host destroyed the underlying webContents: detach the
    // dead view from the contentView and reset the added-flag so the new view
    // gets re-mounted (otherwise the `hostToolbarViewAdded` guard would skip the
    // addChildView and the toolbar would silently disappear).
    if (hostToolbarView && hostToolbarViewAdded) {
      try {
        ctx.windows.mainWindow.contentView.removeChildView(hostToolbarView)
      } catch { /* already removed */ }
      hostToolbarViewAdded = false
    }
    // The framework's height-advertiser runtime is SESSION-resident: register
    // it on session.defaultSession (ref-counted across coexisting managers)
    // BEFORE the view exists, so the very first load already runs it. The
    // toolbar WCV stays on the defaultSession (no partition/session override)
    // — moving it onto its own partition would silently detach it from this
    // registration and height advertising would die with no error.
    if (!hostToolbarRuntimeAcquired) {
      acquireHostToolbarSessionRuntime()
      hostToolbarRuntimeAcquired = true
    }
    // `webPreferences.preload` is the HOST's alone (setPreloadPath); the
    // built-in advertiser no longer rides it (it would execute twice — the
    // session copy + the webPreferences copy). The additionalArguments marker
    // is what the session runtime's guard keys on to activate here and stay a
    // zero-footprint no-op in every other defaultSession renderer.
    const webPreferences: Electron.WebPreferences = {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      additionalArguments: [HOST_TOOLBAR_RUNTIME_MARKER],
    }
    if (hostToolbarPreloadOverride !== null) {
      webPreferences.preload = hostToolbarPreloadOverride
    }
    const view = new WebContentsView({ webPreferences })
    hostToolbarView = view
    // Hook the per-load MessagePort handshake (did-finish-load) + dead-port
    // cleanup (destroyed) on the fresh wc. AFTER the assignment above so the
    // channel's isCurrent guard sees this wc as the live one.
    hostToolbarPort.attach(view.webContents)
    // Paint the surface a neutral color so growing the reserved strip never
    // flashes white before the host content paints (mirrors the native
    // simulator's setBackgroundColor anti-flash).
    try { view.setBackgroundColor('#121212') } catch { /* stub may lack it */ }
    // The host may load arbitrary URLs; route popups + cross-origin in-place
    // navigation to the OS browser (mirror the native simulator hardening).
    try {
      view.webContents.setWindowOpenHandler(({ url }) => handleWindowOpenExternal(url))
    } catch { /* stub may lack it */ }
    return view
  }

  function setHostToolbarBounds(bounds: layout.Bounds): void {
    if (ctx.windows.mainWindow.isDestroyed()) return
    // Zero-area rect means "hide" — remove the child view but keep its
    // WebContents (and the host's loaded content) alive. Do NOT create the
    // view just to immediately hide it.
    if (isHidden(bounds)) {
      if (hostToolbarView && hostToolbarViewAdded && liveHostToolbarWebContents()) {
        try {
          ctx.windows.mainWindow.contentView.removeChildView(hostToolbarView)
        } catch { /* already removed */ }
      }
      hostToolbarViewAdded = false
      return
    }
    const view = ensureHostToolbarView()
    if (!hostToolbarViewAdded) {
      // addChildView appends = topmost z-order, which is correct for a strip
      // that sits above the devtools header.
      ctx.windows.mainWindow.contentView.addChildView(view)
      hostToolbarViewAdded = true
    }
    view.setBounds(bounds)
  }

  // Single funnel for the height notify: retain-then-push, so the retained
  // value is exactly the last value the renderer was told. Every height
  // notify site MUST go through here — the renderer pulls the retained value
  // on project-view mount to replay a push it missed (the toolbar's
  // size-advertiser deduplicates and never re-reports).
  function notifyHostToolbarHeight(height: number): void {
    hostToolbarLastHeight = height
    ctx.notify.hostToolbarHeightChanged(height)
    if (settingsViewAdded) applySettingsBounds()
    if (popoverView) applyPopoverBounds()
  }

  function setHostToolbarHeight(extent: number): void {
    // While the host pins a fixed height, drop advertiser reports entirely —
    // the session-resident advertiser is always installed, so forwarding its
    // reports would make the strip oscillate between the pinned and measured
    // heights on every content resize. Dropped reports must not touch the
    // retained value either: retention records what was NOTIFIED, not what
    // was reported.
    if (hostToolbarHeightMode !== 'auto') return
    // Push the reserved height back to the main-window renderer so its
    // placeholder div resizes (closing the dynamic-height loop). The notified
    // height IS retained in main (`getHostToolbarHeight`) so a renderer that
    // mounts later can pull/replay it; the renderer placeholder remains the
    // geometry authority — the forward anchor re-reports bounds from it.
    notifyHostToolbarHeight(extent)
  }

  function hideHostToolbar(): void {
    if (hostToolbarView && hostToolbarViewAdded && !ctx.windows.mainWindow.isDestroyed()) {
      try {
        ctx.windows.mainWindow.contentView.removeChildView(hostToolbarView)
      } catch { /* already removed */ }
    }
    hostToolbarViewAdded = false
    // Collapse the renderer placeholder to 0 too. Otherwise its anchor keeps a
    // non-zero reserved height and re-publishes bounds on the next window
    // resize, silently re-adding the view we just hid (unstable hide). Zeroing
    // the height flips the anchor to `present:false` so it stops re-publishing.
    // Through the funnel so the retained value follows to 0 — a renderer
    // mounting after the hide must replay 0, not the stale pre-hide height.
    notifyHostToolbarHeight(0)
  }

  const hostToolbar: HostToolbarControl = {
    async loadURL(url: string): Promise<void> {
      const view = ensureHostToolbarView()
      // Invalidate SYNCHRONOUSLY at initiation, before the load is issued:
      // the current document is about to be replaced, so a same-tick send()
      // must report false instead of confirming delivery into it. The channel
      // recovers on the new document's did-finish-load handshake. (Cannot
      // rely on did-start-navigation here — that only covers page-initiated
      // navigations once the load is actually under way.)
      hostToolbarPort.invalidate()
      await view.webContents.loadURL(url)
    },
    async loadFile(filePath: string): Promise<void> {
      const view = ensureHostToolbarView()
      // Same initiation-invalidates contract as loadURL above.
      hostToolbarPort.invalidate()
      await view.webContents.loadFile(filePath)
    },
    get webContents(): WebContents | null {
      return liveHostToolbarWebContents()
    },
    hide(): void {
      hideHostToolbar()
    },
    setPreloadPath(path: string | null): void {
      // The HOST's own webPreferences.preload, applied when the view is next
      // (re)created. `null` = no host preload. The framework advertiser is
      // session-resident and unaffected either way (see ensureHostToolbarView).
      hostToolbarPreloadOverride = path
    },
    setHeightMode(mode: HostToolbarHeightMode): void {
      // Validate BEFORE touching any state: a poisoned `{ fixed }` (NaN /
      // ±Infinity / negative) must neither reach the renderer placeholder
      // (`height: NaNpx` corrupts the strip with no error anywhere) nor
      // clobber the standing mode — fail-closed, not fail-corrupt.
      if (mode !== 'auto' && !(Number.isFinite(mode.fixed) && mode.fixed >= 0)) {
        throw new TypeError(
          `hostToolbar.setHeightMode: fixed height must be a finite, non-negative number (got ${mode.fixed})`,
        )
      }
      hostToolbarHeightMode = mode
      if (mode !== 'auto') {
        // Pin immediately: a preload-less/static toolbar never advertises, so
        // waiting for the next report would leave the strip at height 0.
        notifyHostToolbarHeight(mode.fixed)
      }
      // Switching back to 'auto' deliberately does NOT synthesize a notify —
      // replaying a stale cached height would flash the old size; the NEXT
      // advertiser report drives the placeholder again. The RETAINED value
      // survives the switch though: a freshly-mounting renderer still needs
      // the pinned height until that next report lands.
    },
    onMessage(channel, handler): HostToolbarMessageSubscription {
      return hostToolbarPort.onMessage(channel, handler)
    },
    onReady(handler): HostToolbarMessageSubscription {
      return hostToolbarPort.onReady(handler)
    },
    send(channel, payload): boolean {
      return hostToolbarPort.send(channel, payload)
    },
  }

  function overlayHeaderHeight(): number {
    return HEADER_H + hostToolbarLastHeight
  }

  function applySettingsBounds(): void {
    if (!settingsView || ctx.windows.mainWindow.isDestroyed()) return
    const [w = 0, h = 0] = ctx.windows.mainWindow.getContentSize()
    settingsView.setBounds(layout.computeSettingsBounds(w, h, overlayHeaderHeight()))
  }

  function applyPopoverBounds(): void {
    if (!popoverView || ctx.windows.mainWindow.isDestroyed()) return
    const [w = 0, h = 0] = ctx.windows.mainWindow.getContentSize()
    popoverView.setBounds(layout.computePopoverBounds(w, h, overlayHeaderHeight()))
  }

  function clearNativeDevtoolsRetry(): void {
    nativeDevtoolsRetryToken++
    if (nativeDevtoolsRetryTimer) {
      clearTimeout(nativeDevtoolsRetryTimer)
      nativeDevtoolsRetryTimer = null
    }
  }

  function closeNativeDevtoolsSource(): void {
    const source = nativeDevtoolsSourceWc
    nativeDevtoolsSourceWc = null
    try { stopServiceConsole?.() } catch { /* already stopped */ }
    stopServiceConsole = null
    if (!source || source.isDestroyed()) return
    try {
      if (source.isDevToolsOpened()) {
        source.closeDevTools()
      }
    } catch { /* source may be mid-destroy */ }
  }

  function stopFollowingNativeServiceHost(): void {
    clearNativeDevtoolsRetry()
    if (unsubscribeNativeRenderEvents) {
      try {
        unsubscribeNativeRenderEvents()
      } catch { /* ignore */ }
      unsubscribeNativeRenderEvents = null
    }
    closeNativeDevtoolsSource()
  }

  // ── Open-in-editor: click a console file link → workbench ──────────────
  // The right-panel console is the embedded Chromium DevTools front-end. Once a
  // sourcemap maps a console frame back to source (restored by the service-host
  // importScripts sourcemap rewrite), we redirect a source-link click to OUR
  // workbench editor instead of the DevTools Sources panel: install an "open
  // resource handler" in the front-end realm that encodes (url, line, col) into
  // a sentinel URL and asks the front-end to open it; Electron surfaces that as
  // `devtools-open-url` on the inspected (service-host) wc, which we decode,
  // map to a project-relative path, and reveal in the workbench WCV.
  const openInEditorWiredWcIds = new Set<number>()

  function injectOpenResourceHandler(serviceWc: WebContents, devtoolsWc: WebContents): void {
    // Inject the front-end glue that routes a project source-link click to our
    // Monaco editor instead of the DevTools Sources panel: a capture-phase click
    // interceptor re-emits an encoded sentinel via
    // `InspectorFrontendHost.openInNewTab` → Electron `devtools-open-url`. (The
    // legacy `setOpenResourceHandler` hook this used to rely on is gone in
    // current Chromium, so the script keeps it only as a fallback.) Best-effort:
    // the script is fully try/catch-wrapped so a missing API never throws.
    const sourceContext = projectSourceContextFromServiceHostUrl(
      serviceWc.getURL(),
      ctx.workspace?.getProjectPath?.(),
    )
    if (!sourceContext) return
    devtoolsWc.executeJavaScript(buildDevtoolsProjectSourceLinksScript(sourceContext)).catch(() => {})
  }

  // ── DevTools tab customization: keep only Elements/Console/Network ──────────
  // Inject into the same DevTools front-end host wc that the console/network
  // injectors target. Reorders Elements/Console/Network to the front and closes
  // every other panel tab by driving the front-end's UI.ViewManager /
  // InspectorView.tabbedLocation (see ./devtools-tabs.ts). Best-effort: the
  // injected script bounded-polls for the lazily-registered panels, wraps
  // everything in try/catch, and silently no-ops if the API never appears —
  // DevTools default tab behaviour is preserved on any failure. Re-injected on
  // every (re)point so a re-`openDevTools` (service-host pool swap) re-applies.
  function customizeDevtoolsTabs(devtoolsWc: WebContents): void {
    try {
      if (devtoolsWc.isDestroyed()) return
      const inject = (): void => {
        if (devtoolsWc.isDestroyed()) return
        try {
          void devtoolsWc.executeJavaScript(buildCustomizeTabsScript()).catch(() => {})
        } catch { /* wc torn down mid-call */ }
      }
      if (devtoolsWc.isLoading()) {
        devtoolsWc.once('dom-ready', inject)
      } else {
        inject()
      }
    } catch { /* wc surface incomplete / torn down; degrade silently */ }
  }

  function wireOpenInEditor(serviceWc: WebContents, devtoolsWc: WebContents): void {
    // Inject the front-end handler on every (re)attach — the DevTools front-end
    // wc is recreated per simulatorView, so a fresh host needs the handler set.
    if (!devtoolsWc.isDestroyed()) {
      if (devtoolsWc.isLoading()) {
        devtoolsWc.once('dom-ready', () => injectOpenResourceHandler(serviceWc, devtoolsWc))
      } else {
        injectOpenResourceHandler(serviceWc, devtoolsWc)
      }
    }
    // Attach the `devtools-open-url` decoder to the inspected service wc once
    // (the listener is keyed off the encoded sentinel scheme, so it only acts on
    // OUR redirected links; any other devtools "open in new tab" falls through).
    if (openInEditorWiredWcIds.has(serviceWc.id)) return
    openInEditorWiredWcIds.add(serviceWc.id)
    const onOpenUrl = (_event: Electron.Event, url: string): void => {
      const req = decodeOpenInEditorUrl(url)
      if (!req) return // not our sentinel — leave it to Electron's default path
      const target = resolveProjectEditorTarget(
        serviceWc.getURL(),
        ctx.workspace?.getProjectPath?.(),
        req,
      )
      if (!target) return
      // Drive the workbench WCV (the sole editor) when it is attached, AND
      // always emit `editor:openFile` — it carries the editor-agnostic mapping
      // (project-relative path + 1-based line) that downstream/consumers (and the
      // open-in-editor contract test) observe; with Monaco gone it has no
      // renderer subscriber, so emitting it is harmless when the workbench
      // handles the actual reveal.
      openFileInWorkbench(target.path, target.line ?? 1, target.column ?? 1)
      ctx.notify.editorOpenFile(target)
    }
    serviceWc.on('devtools-open-url', onOpenUrl)
    // Consolidate teardown onto the connection layer (foundation.md §4 / P2),
    // but as a wc-LIFETIME resource: the open-in-editor wiring inspects this
    // service-host wc and must SURVIVE pool reuse (`reset`) — the dedup set
    // entry + listener stay valid across sessions reusing the same wc, and the
    // early-return dedup above correctly skips re-wiring after a reset. So we
    // register on `'closed'` (fires only on real wc destroy), NOT `own()`
    // (which also fires on `reset` and would leave the wc un-wired after reuse
    // because re-pointing the same wc.id early-returns). acquire() is
    // idempotent — bridge-router owning session-scoped resources on the same
    // serviceWc connection coexists cleanly.
    const conn = ctx.connections.acquire(serviceWc)
    conn.on('closed', () => {
      openInEditorWiredWcIds.delete(serviceWc.id)
      try { serviceWc.removeListener('devtools-open-url', onOpenUrl) } catch { /* wc gone */ }
    })
  }

  // Point the right-panel Chrome DevTools front-end at `next` — the SERVICE HOST
  // webContents (logic layer). Idempotent: if we already inspect this wc, no-op.
  function pointNativeDevtoolsAtServiceWc(next: WebContents): boolean {
    if (!simulatorView || simulatorView.webContents.isDestroyed()) return true
    if (nativeDevtoolsSourceWc?.id === next.id && !nativeDevtoolsSourceWc.isDestroyed()) {
      return true
    }
    closeNativeDevtoolsSource()
    nativeDevtoolsSourceWc = next

    try {
      next.setDevToolsWebContents(simulatorView.webContents)
      // DevTools renders into the right-panel host view (simulatorView); with a
      // custom host the `mode` is overridden, and `activate:false` prevents it
      // stealing focus — this re-points whenever the service window is swapped,
      // so a focusing window would yank focus repeatedly (disrupting the user /
      // e2e).
      next.openDevTools({ mode: 'detach', activate: false })
      // Redirect console source-link clicks to the workbench editor.
      wireOpenInEditor(next, simulatorView.webContents)
      // Keep only Elements/Console/Network tabs (front-most, in that order).
      // Re-applied on every re-point so a service-host pool swap (fresh
      // openDevTools) re-asserts the custom tab bar.
      customizeDevtoolsTabs(simulatorView.webContents)
      // Capture service-layer console via CDP (NOT a preload monkeypatch, which
      // would clobber native source attribution) and feed it to the console
      // fan-out (automation `App.logAdded`). Bound to THIS service wc; replaced
      // on the next re-point via closeNativeDevtoolsSource.
      try { stopServiceConsole?.() } catch { /* already stopped */ }
      stopServiceConsole = installServiceConsoleForward({
        serviceWc: next,
        connections: ctx.connections,
        emit: (entry) => ctx.consoleForwarder?.emit(entry),
      }).stop
      return true
    } catch {
      if (nativeDevtoolsSourceWc?.id === next.id) {
        nativeDevtoolsSourceWc = null
      }
      return false
    }
  }

  // Resolve the SERVICE HOST webContents for the active (or named) app. This is
  // the hidden service BrowserWindow's wc — a top-level wc that CAN host a
  // Chrome DevTools front-end (unlike a `<webview>` guest's). Re-resolved fresh
  // so a pre-warm-pool swap on respawn is tolerated.
  function pointNativeDevtoolsAtActiveServiceHost(appId?: string): boolean {
    if (!ctx.bridge?.isNativeHost()) return true
    if (!simulatorView || simulatorView.webContents.isDestroyed()) return true

    const wc = ctx.bridge.getServiceWc(appId)
    if (!wc || wc.isDestroyed()) return false
    return pointNativeDevtoolsAtServiceWc(wc)
  }

  function scheduleNativeDevtoolsFollow(appId?: string, attempt = 0): void {
    if (attempt >= 20) return
    if (!ctx.bridge?.isNativeHost()) return
    const token = nativeDevtoolsRetryToken
    if (nativeDevtoolsRetryTimer) clearTimeout(nativeDevtoolsRetryTimer)
    nativeDevtoolsRetryTimer = setTimeout(() => {
      nativeDevtoolsRetryTimer = null
      if (token !== nativeDevtoolsRetryToken) return
      if (pointNativeDevtoolsAtActiveServiceHost(appId)) return
      scheduleNativeDevtoolsFollow(appId, attempt + 1)
    }, 50)
  }

  function followNativeDevtoolsServiceHost(appId?: string): void {
    clearNativeDevtoolsRetry()
    if (pointNativeDevtoolsAtActiveServiceHost(appId)) return
    scheduleNativeDevtoolsFollow(appId)
  }

  // Render-side activity (a page DOM mounting / the visible page changing)
  // always follows a spawn or respawn, by which point the service window exists
  // (and may have been swapped by the pool). Re-resolve + re-point the DevTools
  // at the now-current service host on every such event.
  function onNativeRenderEvent(event: RenderEvent): void {
    if (event.kind !== 'activePage' && event.kind !== 'domReady') return
    followNativeDevtoolsServiceHost(event.appId)
  }

  // ── ViewManager methods ─────────────────────────────────────────────────

  function attachNativeSimulatorDevtoolsHost(): void {
    stopFollowingNativeServiceHost()

    // Destroy old simulatorView to prevent WebContentsView leak
    if (simulatorView) {
      removeSimulatorDevtoolsView()
      try {
        if (!simulatorView.webContents.isDestroyed()) {
          simulatorView.webContents.close()
        }
      } catch { /* ignore */ }
      simulatorView = null
    }

    simulatorView = new WebContentsView()

    // Default DevTools to Console panel (Chrome DevTools defaults to Elements).
    // The DevTools UI lives inside closed shadow roots, so a light-DOM
    // querySelector('[role="tab"]') cannot reach the tab bar to click it.
    // Instead drive the front-end's own view manager: the bundled DevTools
    // exposes `UI.ViewManager.instance().showView(id)` on `globalThis.UI`
    // once the front-end has finished bootstrapping. We poll for it and
    // request the `console` view, and also persist the choice via the
    // `panel-selectedTab` localStorage key so subsequent reloads honor it.
    const devtoolsWc = simulatorView.webContents
    // Hand the network forwarder THIS front-end host wc — it injects the
    // simulator WCV's Network.* CDP events into `window.DevToolsAPI.dispatchMessage`
    // here so the native Network tab renders them (falls back to the service-host
    // console line when null / the API never appears). Cleared on detach.
    ctx.networkForward?.setDevtoolsHost(devtoolsWc)
    // Elements forwarding (production, always on for the native simulator): route
    // the front-end's Elements-panel CDP traffic (DOM/CSS/Overlay/DOMSnapshot/
    // DOMDebugger) onto the ACTIVE RENDER GUEST so the panel reflects the page's
    // live DOM tree instead of the service host it natively inspects. Reuses the
    // safe-area-attached debugger session (never detaches one it doesn't own);
    // Emulation.* and every other domain stay on the service-host path. Degrades
    // to the native service-host DOM if the front-end hook is unavailable. The
    // disposer is stopped on detach / host destroyed.
    if (ctx.bridge) {
      try {
        stopElementsForward?.()
      } catch { /* prior disposer already gone */ }
      // Capture THIS instance's disposer in the destroy handler — NOT the mutable
      // `stopElementsForward`. A respawn creates a new simulatorView whose old
      // devtools host wc is destroyed AFTER the new instance is already installed;
      // a handler closing over `stopElementsForward` would then dispose the CURRENT
      // instance (its reconcile loop never gets to install the hook, so Elements
      // falls back to the natively-inspected service host). Stop only this wc's own
      // forward, and clear the module pointer only while it still points here.
      const thisForward = installElementsForward({ devtoolsWc, bridge: ctx.bridge, connections: ctx.connections })
      stopElementsForward = thisForward
      devtoolsWc.once('destroyed', () => {
        try { thisForward() } catch { /* already stopped */ }
        if (stopElementsForward === thisForward) stopElementsForward = null
      })
    }
    devtoolsWc.once('dom-ready', () => {
      devtoolsWc.executeJavaScript(`
        (function() {
          try { localStorage.setItem('panel-selectedTab', '"console"') } catch {}
          let tries = 0
          const timer = setInterval(() => {
            tries++
            try {
              const UI = globalThis.UI
              const vm = UI && UI.ViewManager && typeof UI.ViewManager.instance === 'function'
                ? UI.ViewManager.instance()
                : null
              if (vm && typeof vm.showView === 'function') {
                vm.showView('console')
                clearInterval(timer)
                return
              }
            } catch {}
            if (tries > 80) clearInterval(timer)
          }, 50)
        })()
      `).catch(() => {})
    })

    // Anchor-only mount: the renderer's published rect is the SOLE authority.
    // If a non-zero rect was already published (it can land before this attach
    // on the project-open ordering), replay it; otherwise the view stays
    // unadded and unsized until the first publish arrives. No static-layout
    // fallback — an attach-time computed rect raced the precise anchor rect
    // and flashed the overlay at the wrong rectangle.
    if (simulatorBoundsOverride && !isHidden(simulatorBoundsOverride)) {
      ctx.windows.mainWindow.contentView.addChildView(simulatorView)
      simulatorViewAdded = true
      simulatorView.setBounds(simulatorBoundsOverride)
    }

    if (ctx.bridge?.isNativeHost()) {
      unsubscribeNativeRenderEvents = ctx.bridge.onRenderEvent(onNativeRenderEvent)
      followNativeDevtoolsServiceHost()
    }
  }

  /**
   * Remove the custom-apis bridge `ipcMain.on` listener, if any. Idempotent.
   */
  function detachNativeCustomApiBridge(): void {
    if (nativeCustomApiBridgeHandler) {
      ipcMain.removeListener(SimulatorCustomApiBridgeChannel.Request, nativeCustomApiBridgeHandler)
      nativeCustomApiBridgeHandler = null
    }
  }

  /**
   * NATIVE-HOST ONLY. The native simulator is a top-level WebContentsView with
   * NO embedder renderer, so the simulator-side `__diminaCustomApis` bridge
   * (`src/preload/runtime/custom-apis.ts`) cannot reach the host via
   * `ipcRenderer.sendToHost` — that only delivers to a `<webview>`'s embedder,
   * which is how the default path's `useCustomApiProxy` answered it. A
   * top-level WebContentsView has no embedder, and `sendToHost` does NOT loop
   * back as `ipc-message-host` on itself, so that channel never fires here.
   *
   * Under native-host the bridge instead talks to `ipcMain` directly (the same
   * way `installNativeHostBridge` issues SPAWN/PAGE_OPEN): the preload sends
   * `SimulatorCustomApiBridgeChannel.Request` via `ipcRenderer.send`, this
   * `ipcMain.on` listener answers it. We do NOT route through `IpcRegistry` /
   * the sender-policy white-list (the simulator is deliberately kept off it);
   * instead we accept the message ONLY when `event.sender` is THIS precise
   * simWc — the same trust model bridge-router uses for the simulator's own
   * SPAWN messages. The result is dispatched through the shared
   * `ctx.simulatorApis` registry and the id-correlated `Response` is posted
   * back via `simWc.send`, which the preload's `ipcRenderer.on(Response)`
   * listener settles.
   */
  function attachNativeCustomApiBridge(simWc: WebContents): void {
    // Re-attach defensively: a stale listener from a prior simWc must never
    // linger. (attachNativeSimulator already tears the old view down first.)
    detachNativeCustomApiBridge()

    const apis = ctx.simulatorApis
    if (!apis) return

    const simWcId = simWc.id
    const handler = (event: IpcMainEvent, req: unknown): void => {
      // Trust gate: only the exact native simulator webContents may drive this.
      if (event.sender.id !== simWcId) return
      const r = req as CustomApiBridgeRequest | undefined
      if (!r || typeof r.id !== 'number') return
      void handleCustomApiBridgeRequest(apis, r).then((response) => {
        if (simWc.isDestroyed()) return
        simWc.send(SimulatorCustomApiBridgeChannel.Response, response)
      }).catch(() => { /* simWc torn down mid-dispatch; drop */ })
    }

    nativeCustomApiBridgeHandler = handler
    ipcMain.on(SimulatorCustomApiBridgeChannel.Request, handler)
    // Consolidate this per-webContents teardown onto the connection layer
    // (foundation.md §4 / P1 DoD #3): acquiring the simWc connection makes the
    // registry track this trusted webContents, and `own()`-ing the detach ties
    // the ipcMain listener's lifetime to the connection so it's torn down
    // deterministically when the wc is destroyed (or the connection is reset),
    // instead of a bespoke `once('destroyed')`. The detach stays idempotent, so
    // the defensive re-attach path calling it directly remains safe.
    ctx.connections.acquire(simWc).own(detachNativeCustomApiBridge)
  }

  function attachNativeSimulator(simulatorUrl: string, _simWidth: number): Promise<void> {
    if (!ctx.preloadPath) {
      console.error('[workbench] attachNativeSimulator — preloadPath unset; cannot mount native simulator')
      return Promise.resolve()
    }

    // Unblock a superseded IPC invocation. Its renderer effect cleanup marks
    // that generation cancelled, so this cannot schedule a stale capture.
    settleNativeSimulatorReady?.()
    settleNativeSimulatorReady = null

    // Tear down any previous native simulator view (relaunch / re-open).
    if (nativeSimulatorView) {
      detachNativeCustomApiBridge()
      if (nativeSimulatorViewAdded) {
        try {
          ctx.windows.mainWindow.contentView.removeChildView(nativeSimulatorView)
        } catch { /* already removed */ }
        nativeSimulatorViewAdded = false
      }
      try {
        if (!nativeSimulatorView.webContents.isDestroyed()) {
          // Clear the outgoing project's bridge sessions (render guests +
          // service host) synchronously BEFORE the WCV's own async close(), so a
          // relaunch never re-resolves or re-renders the previous guest. The
          // sync prefix clears the maps now; observe the async tail so a
          // pool/resource release rejection is logged, not swallowed.
          ctx.bridge?.disposeSessionsForSimulator?.(nativeSimulatorView.webContents.id)
            ?.catch((err) => console.warn('[view-manager] dispose sessions (relaunch) failed:', err))
          nativeSimulatorView.webContents.close()
        }
      } catch { /* ignore */ }
      nativeSimulatorView = null
    }
    nativeSimulatorProjectPath = null

    const ready = new Promise<void>((resolve) => {
      settleNativeSimulatorReady = resolve
    })

    // Derive THIS project's session partition from the simulator URL's appId so
    // its cookies/localStorage/cache are isolated from every other project (P0
    // debt). Same project → same partition (storage survives a relaunch);
    // unknown appId → the shared fallback. Configure the partition's session
    // (protocol handlers + CORS/referer policy) before any project content loads
    // on it — idempotent per partition.
    const route = parseRoute(simulatorUrl)
    // Include the project path so two projects that declare the same appId at
    // different paths get isolated partitions. The service-host window for THIS
    // project derives its partition from the same (appId, projectPath) pair so
    // render guests + service host still share one session.
    const partition = miniappPartition(route?.appId, ctx.workspace?.getProjectPath())
    configureMiniappSession(partition)

    // The simulator preload is a CJS bundle; webPreferences.preload obeys the
    // `.js` + "type":"module" ESM rule (require would be undefined), so hand the
    // top-level WebContentsView the `.cjs` sibling. contextIsolation:false +
    // sandbox:false + webviewTag:true mirror what the default `<webview>` guest
    // runs with, and the per-project `persist:miniapp-<key>` partition shares
    // storage + the session-registered preload/CORS rules with the rest of THIS
    // project's simulator (render guests + service host), never other projects'.
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: false,
        sandbox: false,
        webviewTag: true,
        preload: cjsSiblingPreloadPath(ctx.preloadPath),
        partition,
      },
    })
    nativeSimulatorView = view
    nativeSimulatorProjectPath = ctx.workspace?.getProjectPath() || null
    // Paint the WCV surface the themed desk color (simDeskBg(): dark #121212 /
    // light #e8e8e8) so a height-resize that grows the region never flashes a
    // mismatched strip before DeviceShell's desk repaints — the WCV, the desk,
    // and the renderer placeholder behind it are all the same color.
    view.setBackgroundColor(simDeskBg())
    const simWc = view.webContents

    // Keep the WCV surface in sync with the active color scheme. The
    // process-wide installThemeBackgroundSync() re-syncs BrowserWindows on a
    // theme switch, but this top-level WebContentsView is not a window, so its
    // creation-time backgroundColor would otherwise freeze. Mirror simDeskBg()
    // here on every nativeTheme `updated`; the listener is owned by the wc's
    // connection so it detaches when the simulator view is torn down.
    const syncDeskBg = (): void => {
      try {
        if (!simWc.isDestroyed()) view.setBackgroundColor(simDeskBg())
      } catch { /* view/wc gone */ }
    }
    nativeTheme.on('updated', syncDeskBg)
    ctx.connections.acquire(simWc).own(() => nativeTheme.removeListener('updated', syncDeskBg))

    // Service the simulator-side `__diminaCustomApis` bridge: this top-level
    // WebContentsView has no embedder renderer to proxy through, so dispatch its
    // `sendToHost` requests straight to `ctx.simulatorApis` from main.
    attachNativeCustomApiBridge(simWc)

    // DeviceShell mounts per-page render-host `<webview>`s INSIDE this view.
    // Pin them onto the SAME per-project partition as their host WCV (so render
    // and the rest of this project share one localStorage/cookie jar) and run
    // them with contextIsolation/sandbox off so the render runtime + its preload
    // share the page realm. (A top-level WebContentsView can host these guests; a
    // `<webview>` guest cannot — that's the whole point of Option A.)
    // Page type (`isTab`) of each attaching guest, captured from its render-host
    // URL in will-attach (where `params.src` carries the full URL) and consumed
    // FIFO in the matching did-attach — `guestWc.getURL()` is still empty there.
    // Per-attach scope: a fresh simWc + handlers are built on every (re)attach.
    const pendingGuestIsTab: boolean[] = []
    simWc.on('will-attach-webview', (_event, webPreferences, params) => {
      ;(webPreferences as Electron.WebPreferences).partition = partition
      params.partition = partition
      webPreferences.contextIsolation = false
      ;(webPreferences as Electron.WebPreferences).sandbox = false
      let isTab = false
      try { isTab = new URL(params.src).searchParams.get('isTab') === '1' } catch { /* keep false */ }
      pendingGuestIsTab.push(isTab)
    })
    simWc.on('did-attach-webview', (_event, guestWc) => {
      // Scale the nested render-host page with the device zoom. The host WCV is
      // sized to the SCALED bezel rect and runs at `currentZoomFactor`, so the
      // guest must run at the same factor to lay the page out at the logical
      // device width and paint at the right scale. At 100% (default) this is a
      // no-op identity (factor 1). Newly-attached guests pick up the latest
      // zoom here; live zoom changes re-apply via setNativeSimulatorViewBounds.
      try {
        guestWc.setZoomFactor(currentZoomFactor)
      } catch { /* guest not ready; setNativeSimulatorViewBounds re-applies */ }
      // Simulate this device's CSS env(safe-area-inset-*) on the fresh guest
      // before it paints, so notch-aware page layout resolves correctly. The
      // bottom inset is page-type-dependent (see services/safe-area): a tab
      // page's content sits above the shell tabBar (bottom 0); a non-tab page
      // is full-bleed (real bottom inset). The page type was captured from the
      // render-host URL in will-attach (FIFO).
      const isTabGuest = pendingGuestIsTab.shift() ?? false
      safeArea.applyToGuest(guestWc, ctx.bridge?.getDevice() ?? null, isTabGuest)
      guestWc.setWindowOpenHandler(({ url }) => handleWindowOpenExternal(url))
      guestWc.on('will-navigate', (e, url) => {
        try {
          const u = new URL(url)
          if (u.protocol === 'about:') return
          if ((u.protocol === 'http:' || u.protocol === 'https:')
              && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
            return
          }
          if (u.protocol === 'file:') return
          e.preventDefault()
          if (u.protocol === 'http:' || u.protocol === 'https:') {
            void shell.openExternal(url)
          }
        } catch {
          e.preventDefault()
        }
      })
      // The outer DeviceShell loading is insufficient: slow projects attach a
      // render guest later. Resolve the renderer's attach IPC only after that
      // first mini-app page has completed its own document load.
      guestWc.once('did-finish-load', () => {
        if (nativeSimulatorView !== view || simWc.isDestroyed()) return
        settleNativeSimulatorReady?.()
        settleNativeSimulatorReady = null
      })
      // A render-host guest only attaches after a spawn, so the service window
      // exists by now — (re)point the right-panel DevTools at it. Belt-and-braces
      // with the `onRenderEvent` path in case its emit lost the attach race.
      followNativeDevtoolsServiceHost()
    })

    // The simulator loads http://localhost:<port>/simulator.html. Harden popups
    // + in-place navigation: allow the dev server origin (and about:blank /
    // file:// render hosts), route everything else to the OS browser.
    simWc.setWindowOpenHandler(({ url }) => handleWindowOpenExternal(url))
    simWc.on('will-navigate', (e, url) => {
      try {
        const u = new URL(url)
        if (u.protocol === 'about:') return
        if (u.protocol === 'file:') return
        if ((u.protocol === 'http:' || u.protocol === 'https:')
            && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
          return
        }
        e.preventDefault()
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          void shell.openExternal(url)
        }
      } catch {
        e.preventDefault()
      }
    })

    void simWc.loadURL(simulatorUrl).catch((err) => {
      console.error('[workbench] attachNativeSimulator — loadURL failed', err)
    })

    // This WebContentsView's webContents IS the simulator: the native-host
    // preload runs here and issues SPAWN, so bridge-router resolves
    // ap.simulatorWc = event.sender = this wc, and SIMULATOR_EVENTS flow back.
    simulatorWebContentsId = simWc.id

    // Forward this WCV's network requests (wx.request/download/upload run here,
    // not in the service host) into the service-host console so they show in the
    // embedded DevTools the right panel hosts. Attaches the CDP debugger; no-op
    // if the forwarder is unwired (partial test ctx) or the debugger is claimed.
    ctx.networkForward?.attachSimulator(simWc)

    // Model A: bounds come ONLY from the renderer's measured inner-screen rect.
    // If a report already landed before this attach (project-open ordering),
    // replay it now — setNativeSimulatorViewBounds adds + sizes the view. Else
    // the view stays unadded until the next reportBounds. No coarse fallback.
    if (lastRendererRect) {
      setNativeSimulatorViewBounds(lastRendererRect)
    }

    // Native-host page code (console.log / wx.request / Sources) runs in the
    // hidden SERVICE HOST window, not this DeviceShell host nor the render-host
    // guests. Keep the right-panel DevTools host view stable and point it at the
    // service host so its Console/Network(fetch)/Sources reflect the logic layer.
    // (The UI/view layer's Elements equivalent is the native WXML panel +
    // render-guest highlight chain, which targets the active render guest.)
    attachNativeSimulatorDevtoolsHost()
    return ready
  }

  function detachSimulator(): void {
    settleNativeSimulatorReady?.()
    settleNativeSimulatorReady = null
    stopFollowingNativeServiceHost()
    detachNativeCustomApiBridge()
    // Stop Elements forwarding (detaches only the debugger sessions IT attached;
    // safe-area's sessions are untouched). Idempotent — the host 'destroyed'
    // handler may have already run.
    try { stopElementsForward?.() } catch { /* already stopped */ }
    stopElementsForward = null
    // Stop forwarding the simulator WCV's network (its debugger is detached as
    // the view is closed below, but drop our session deterministically first).
    // Also drop the DevTools front-end host — its wc is destroyed below; a stale
    // ref would make the forwarder dispatch into a dead wc instead of falling
    // back to the console.
    ctx.networkForward?.detachSimulator()
    ctx.networkForward?.setDevtoolsHost(null)
    // Native-host simulator content view (no-op in the default path).
    if (nativeSimulatorView) {
      if (nativeSimulatorViewAdded && !ctx.windows.mainWindow.isDestroyed()) {
        try {
          ctx.windows.mainWindow.contentView.removeChildView(nativeSimulatorView)
        } catch { /* already removed */ }
      }
      try {
        if (!nativeSimulatorView.webContents.isDestroyed()) {
          // Project close: tear down this project's bridge sessions (render
          // guests + service host) + all mappings synchronously before the WCV's
          // own async close(), so reopening another project starts from a clean
          // state instead of re-resolving / screenshotting the closed project's
          // guest. The 'destroyed' hook stays as an idempotent fallback. The
          // sync prefix clears the maps now; observe the async tail so a
          // pool/resource release rejection is logged, not swallowed.
          ctx.bridge?.disposeSessionsForSimulator?.(nativeSimulatorView.webContents.id)
            ?.catch((err) => console.warn('[view-manager] dispose sessions (close) failed:', err))
          nativeSimulatorView.webContents.close()
        }
      } catch { /* ignore */ }
      nativeSimulatorView = null
      nativeSimulatorViewAdded = false
    }
    hidePopover()
    // Drop the settings view too — the previous detachAllViews() did.
    destroyViewInternal(settingsView)
    settingsView = null
    settingsViewAdded = false
    destroyViewInternal(simulatorView)
    simulatorView = null
    simulatorViewAdded = false
    simulatorWebContentsId = null
    nativeSimulatorProjectPath = null
    // Drop the renderer-published rect so a stale "hidden" override doesn't
    // suppress the next view before its renderer republishes.
    simulatorBoundsOverride = null
    // Also drop the cached native-simulator rect: attachNativeSimulator replays
    // lastRendererRect on attach, so a leftover rect/offset from a torn-down
    // session must not be replayed onto a fresh re-attach (stale slice/offset).
    lastRendererRect = null
  }

  // Remove (but do not destroy) the DevTools overlay from the contentView.
  // Internal teardown helper for re-attach; user-facing visibility is the
  // anchor 0×0 single path (`setSimulatorDevtoolsBounds`).
  function removeSimulatorDevtoolsView(): void {
    if (simulatorView && simulatorViewAdded) {
      try {
        ctx.windows.mainWindow.contentView.removeChildView(simulatorView)
      } catch (e) {
        console.error('[workbench] removeSimulatorDevtoolsView error', e)
      }
      simulatorViewAdded = false
    }
  }

  async function showSettings(): Promise<void> {
    if (!settingsView) {
      settingsView = new WebContentsView({
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: false,
          preload: mainPreloadPath,
        },
      })
      // Overlay loads mainPreloadPath, so the same navigation rules as the
      // main window apply — see navigation-hardening.ts.
      applyNavigationHardening(settingsView.webContents, ctx.rendererDir)
      // Transparent backing: the settings view now spans the whole content area
      // (computeSettingsBounds) and its renderer paints a transparent backdrop +
      // an opaque right-side panel, so the underlying editor/simulator show
      // through and a backdrop click closes the overlay (mirrors the popover).
      settingsView.setBackgroundColor('#00000000')
      await settingsView.webContents.loadFile(
        path.join(ctx.rendererDir, 'entries/settings/index.html'),
      )
    }
    if (!settingsViewAdded) {
      ctx.windows.mainWindow.contentView.addChildView(settingsView)
      settingsViewAdded = true
    }
    applySettingsBounds()
  }

  function hideSettings(): void {
    if (settingsView && settingsViewAdded) {
      try {
        ctx.windows.mainWindow.contentView.removeChildView(settingsView)
      } catch { /* ignore */ }
      settingsViewAdded = false
    }
  }

  // Keep the TOP-tier overlays (settings, popover) above the BASE-tier native
  // overlays (the native simulator WCV + the console/DevTools WCV). Native
  // overlays are z-ordered by `addChildView` insertion order — the last-added
  // sits on top — so RE-attaching a base overlay while a top overlay is open
  // (e.g. the simulator re-shows on a tab switch, or the console bounds
  // republish re-adds it) would move the base ABOVE the open settings/popover
  // and occlude it. Whenever a base overlay is (re)added, re-append the open top
  // overlays so they stay on top. Settings is re-appended before popover so a
  // simultaneously-open popover ends up topmost. A no-op when neither is open
  // (pinned by the z-order guard test).
  function raiseTopOverlays(): void {
    if (ctx.windows.mainWindow.isDestroyed()) return
    const cv = ctx.windows.mainWindow.contentView
    if (settingsView && settingsViewAdded) cv.addChildView(settingsView)
    if (popoverView) cv.addChildView(popoverView)
  }

  function showPopover(data: unknown): void {
    hidePopover()
    const popover = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        preload: mainPreloadPath,
      },
    })
    // Popover overlay loads mainPreloadPath — same navigation rules apply.
    applyNavigationHardening(popover.webContents, ctx.rendererDir)
    popoverView = popover
    popover.setBackgroundColor('#00000000')
    ctx.windows.mainWindow.contentView.addChildView(popover)
    applyPopoverBounds()
    popover.webContents.once('did-finish-load', () => {
      ctx.notify.popoverInit(popover, data)
    })
    popover.webContents.loadFile(
      path.join(ctx.rendererDir, 'entries/popover/index.html'),
    )
  }

  function hidePopover(): void {
    if (popoverView) {
      destroyViewInternal(popoverView)
      popoverView = null
      ctx.notify.popoverClosed()
    }
  }

  function repositionAll(): void {
    // Simulator + DevTools overlay: bounds owned by the renderer's anchor
    // publishes; their ResizeObserver/window-resize listeners re-measure, so
    // no static re-apply here.
    if (settingsView && settingsViewAdded)
      applySettingsBounds()
    if (popoverView)
      applyPopoverBounds()
  }

  function disposeAll(): void {
    detachSimulator()
    // Embedded workbench editor view (no-op when the host never opted in;
    // also removes the devtools-theme sync listener).
    detachWorkbench()
    // Narrow channel first: close the live MessagePort + sweep the onMessage
    // registry, so a send() racing teardown reports false instead of posting
    // into a wc that is about to be closed.
    hostToolbarPort.dispose()
    // Host-controllable toolbar view: removed from the contentView + its
    // WebContents closed (the host's loaded content is torn down on app exit).
    destroyViewInternal(hostToolbarView)
    hostToolbarView = null
    hostToolbarViewAdded = false
    // Release this manager's reference on the shared defaultSession
    // toolbar-runtime registration (only if it ever acquired one — a manager
    // that never used the toolbar must not drive the shared count to zero).
    // The LAST release unregisters; other coexisting managers keep theirs.
    if (hostToolbarRuntimeAcquired) {
      releaseHostToolbarSessionRuntime()
      hostToolbarRuntimeAcquired = false
    }
    safeArea.dispose()
  }

  function setNativeSimulatorViewBounds(
    params: { x: number; y: number; width: number; height: number; zoom: number },
  ): void {
    // Cache unconditionally so attachNativeSimulator can replay a report that
    // landed before the view existed (project-open ordering). This rect is the
    // ONLY authority for the native WCV bounds.
    lastRendererRect = params
    if (ctx.windows.mainWindow.isDestroyed() || !nativeSimulatorView) return
    const p = layout.computeNativeSimulatorViewParams(params, params.zoom)
    currentZoomFactor = p.zoomFactor
    // A zero-area rect means "hide" — the renderer reports this when the
    // simulator panel/cell is toggled off or unmounts (toolbar toggle only
    // mutates renderer layout state, so without this the WCV would stay
    // painted over its old region). Mirror `setSimulatorDevtoolsBounds`:
    // remove the child view from the contentView but keep its WebContents
    // alive, so re-showing doesn't re-pay the simulator bootstrap.
    if (isHidden(p.bounds)) {
      if (nativeSimulatorViewAdded) {
        try {
          ctx.windows.mainWindow.contentView.removeChildView(nativeSimulatorView)
        } catch { /* already removed */ }
        nativeSimulatorViewAdded = false
      }
      return
    }
    if (!nativeSimulatorViewAdded) {
      ctx.windows.mainWindow.contentView.addChildView(nativeSimulatorView)
      nativeSimulatorViewAdded = true
      // Re-attaching this base overlay moved it to the top of the z-stack; keep
      // any open settings/popover above it.
      raiseTopOverlays()
    }
    nativeSimulatorView.setBounds(p.bounds)
    const simWc = nativeSimulatorView.webContents
    if (!simWc.isDestroyed()) {
      simWc.setZoomFactor(p.zoomFactor)
    }
    // Propagate zoom to any already-attached nested render-host guests so the
    // page rescales live on zoom change (newly-attached guests get it in
    // did-attach-webview). `webContents.getAllWebContents()` includes guests;
    // filter to those hosted by this simulator wc.
    try {
      for (const wc of webContents.getAllWebContents()) {
        if (wc.isDestroyed()) continue
        if (wc.hostWebContents === simWc) {
          wc.setZoomFactor(p.zoomFactor)
        }
      }
    } catch { /* hostWebContents unavailable; guests get zoom on attach */ }
  }

  function resize(_simWidth: number): void {
    // Simulator + DevTools overlay bounds are owned solely by the renderer's
    // anchor publishes — its ResizeObserver/window-resize listeners re-measure
    // on this same resize. No static re-apply (it raced the precise rect).
    if (settingsViewAdded) applySettingsBounds()
  }

  return {
    attachNativeSimulator,
    detachSimulator,
    reapplySafeArea: (device) => safeArea.reapplyAll(device),
    showSettings,
    hideSettings,
    showPopover,
    hidePopover,
    repositionAll,
    disposeAll,
    getSimulatorWebContentsId: () => simulatorWebContentsId,
    getSimulatorWebContents: () => {
      if (simulatorWebContentsId == null) return null
      const wc = webContents.fromId(simulatorWebContentsId)
      return wc && !wc.isDestroyed() ? wc : null
    },
    getSimulatorProjectPath: () => nativeSimulatorProjectPath,
    getSettingsWebContents: () => {
      if (!settingsView) return null
      if (settingsView.webContents.isDestroyed()) return null
      return settingsView.webContents
    },
    getSettingsWebContentsId: () => {
      if (!settingsView) return null
      if (settingsView.webContents.isDestroyed()) return null
      return settingsView.webContents.id
    },
    getPopoverWebContentsId: () => {
      if (!popoverView) return null
      if (popoverView.webContents.isDestroyed()) return null
      return popoverView.webContents.id
    },
    getHostToolbarWebContentsId: () => liveHostToolbarWebContents()?.id ?? null,
    getHostToolbarHeight: () => hostToolbarLastHeight,
    setNativeSimulatorViewBounds,
    resize,
    setSimulatorDevtoolsBounds,
    attachWorkbench,
    setWorkbenchSource,
    setWorkbenchBounds,
    detachWorkbench,
    openFileInWorkbench,
    setHostToolbarBounds,
    setHostToolbarHeight,
    hostToolbar,
  }
}
