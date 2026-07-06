import type { WebContents } from 'electron'
import type { NativeDeviceInfo } from '../../../shared/ipc-channels.js'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import { type WorkbenchContext } from '../workbench-context.js'
import type { HostToolbarMessageSubscription } from './host-toolbar-port-channel.js'
import type { PlacementSnapshot } from '@dimina-kit/electron-deck/layout'
import type { DevtoolsExtra } from '../../../shared/view-ids.js'
import { createSafeAreaController } from '../safe-area/index.js'
import { createPlacementReconciler } from './placement-reconciler.js'
import { createWorkbenchView } from './workbench-view.js'
import { createDevtoolsHost } from './native-simulator-devtools-host.js'
import { createHostToolbarView } from './host-toolbar-view.js'
import { createOverlayPanelsView } from './overlay-panels-view.js'
import { createNativeSimulatorView } from './native-simulator-view.js'

export {
  resolveProjectEditorTarget,
  type ProjectEditorTarget,
} from './resolve-project-editor-target.js'

/**
 * Context surface used by the ViewManager. We only need a small slice of the
 * full WorkbenchContext here; typing it this way documents the actual dependency.
 */
export interface ViewManagerContext {
  windows: WorkbenchContext['windows']
  rendererDir: string
  /**
   * Per-webContents connection registry. The native-host
   * simulator WebContentsView is acquired here so the registry tracks that
   * trusted webContents and tears its per-wc resources (the custom-api bridge
   * `ipcMain.on`) down deterministically on destroy. Required:
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
 *
 * This module is the composition root: each view domain lives in its own
 * factory module (simulator, devtools-host, workbench, host-toolbar, overlay
 * panels) and shares a single injected placement reconciler; this file wires
 * them together and exposes their combined method surface.
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
   * Soft-reload the LIVE native simulator after a watcher rebuild: forward a
   * SIMULATOR_EVENTS.RELAUNCH (carrying the rebuilt simulator URL) into the
   * existing WCV so the shell boots a new app session in place and swaps when
   * it is ready — the phone shell never unmounts. Returns false (no event
   * sent) when there is no live simulator view or its shell has not finished
   * its first boot (first render guest did-finish-load); the caller then falls
   * back to the hard attachNativeSimulator rebuild.
   */
  softReloadNativeSimulator(simulatorUrl: string): boolean
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
  /**
   * Destroy the PROJECT-scoped views: the simulator (with its devtools host
   * and settings/popover overlays), the embedded workbench editor, and the
   * per-guest safe-area sessions. Deliberately does NOT touch the host
   * toolbar — its webContents lifecycle belongs to the HOST, so it survives
   * closing a project. This is what `workspace.closeProject()` calls.
   */
  disposeProjectViews(): void
  /**
   * Destroy ALL managed views: everything `disposeProjectViews()` covers PLUS
   * the host toolbar (its view, port channel, and the ref-counted
   * session-runtime preload registration). App/window teardown only — the
   * context's DisposableRegistry runs this so the toolbar's session-level
   * resources are released exactly once, at the end of the manager's life.
   */
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
   * Apply the renderer's window-level placement snapshot — the single source of
   * truth for every managed native view's bounds/visibility/z-order. Merged with
   * main-owned settings/popover desired state and reconciled against the actual
   * view tree.
   */
  setPlacementSnapshot(snapshot: PlacementSnapshot<DevtoolsExtra>): void

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

/**
 * Build a ViewManager bound to the given context. The returned object is the
 * only component allowed to instantiate or add/remove overlay WebContentsViews.
 *
 * All view-related mutable state lives inside the per-domain factory closures
 * (and the single placement reconciler) below, never on the context object.
 */
export function createViewManager(ctx: ViewManagerContext): ViewManager {
  // CSS env(safe-area-inset-*) simulation for render-host guests (per device).
  // Driven from did-attach-webview in the simulator domain and re-pushed on
  // device change via reapplySafeArea. Torn down in disposeAll.
  const safeArea = createSafeAreaController({ connections: ctx.connections })

  // The single level-triggered placement reconciler every view domain shares —
  // the sole owner of placement state (docs/view-placement-reconciler.md). Each
  // domain registers exactly one view slot with it.
  const reconciler = createPlacementReconciler(ctx)

  const workbench = createWorkbenchView(ctx, reconciler)
  const devtoolsHost = createDevtoolsHost(ctx, reconciler, {
    openFileInWorkbench: workbench.openFileInWorkbench,
  })
  // hostToolbar and the overlay panels form a height cycle: the toolbar height
  // offsets the overlays' top edge, and a toolbar height change re-applies the
  // present overlays. The toolbar receives a thunk into the (hoisted) function
  // declaration below so the reference resolves at runtime — after the overlay
  // panels exist — while both domains stay plain const bindings.
  const hostToolbar = createHostToolbarView(ctx, reconciler, {
    reapplyPresentOverlays: () => reapplyToolbarDependentOverlays(),
  })
  const overlayPanels = createOverlayPanelsView(ctx, reconciler, {
    getHostToolbarHeight: hostToolbar.getHostToolbarHeight,
  })
  const nativeSimulator = createNativeSimulatorView(ctx, reconciler, {
    safeArea,
    devtoolsHost,
    overlayPanels,
  })

  function reapplyToolbarDependentOverlays(): void {
    overlayPanels.reapplyPresentOverlays()
  }

  function disposeProjectViews(): void {
    // Aggregate simulator detach first (native simulator + devtools host +
    // settings/popover), then the workbench, then the per-guest safe-area
    // sessions. The host toolbar is exempt: it is HOST-scoped (the host loads
    // and drives it; the height-replay machinery exists precisely for the
    // close-project → reopen flow), so a project's teardown must not kill it.
    nativeSimulator.detachSimulator()
    // Embedded workbench editor view (no-op when the host never opted in;
    // also removes the devtools-theme sync listener).
    workbench.detachWorkbench()
    safeArea.dispose()
  }

  function disposeAll(): void {
    disposeProjectViews()
    // Host-scoped teardown: the toolbar view, its port channel, and the
    // ref-counted session-runtime preload registration.
    hostToolbar.dispose()
  }

  return {
    attachNativeSimulator: nativeSimulator.attachNativeSimulator,
    softReloadNativeSimulator: nativeSimulator.softReloadNativeSimulator,
    detachSimulator: nativeSimulator.detachSimulator,
    reapplySafeArea: (device) => safeArea.reapplyAll(device),
    showSettings: overlayPanels.showSettings,
    hideSettings: overlayPanels.hideSettings,
    showPopover: overlayPanels.showPopover,
    hidePopover: overlayPanels.hidePopover,
    repositionAll: () => overlayPanels.reapplyPresentOverlays(),
    disposeProjectViews,
    disposeAll,
    getSimulatorWebContentsId: nativeSimulator.getSimulatorWebContentsId,
    getSimulatorWebContents: nativeSimulator.getSimulatorWebContents,
    getSimulatorProjectPath: nativeSimulator.getSimulatorProjectPath,
    getSettingsWebContents: overlayPanels.getSettingsWebContents,
    getSettingsWebContentsId: overlayPanels.getSettingsWebContentsId,
    getPopoverWebContentsId: overlayPanels.getPopoverWebContentsId,
    getHostToolbarWebContentsId: hostToolbar.getHostToolbarWebContentsId,
    getHostToolbarHeight: hostToolbar.getHostToolbarHeight,
    resize: () => overlayPanels.applySettingsBoundsIfPresent(),
    setPlacementSnapshot: reconciler.setPlacementSnapshot,
    attachWorkbench: workbench.attachWorkbench,
    setWorkbenchSource: workbench.setWorkbenchSource,
    detachWorkbench: workbench.detachWorkbench,
    openFileInWorkbench: workbench.openFileInWorkbench,
    setHostToolbarHeight: hostToolbar.setHostToolbarHeight,
    hostToolbar: hostToolbar.control,
  }
}
