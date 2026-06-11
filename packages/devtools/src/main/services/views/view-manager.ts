import type { IpcMainEvent, WebContents } from 'electron'
import { ipcMain, shell, WebContentsView, webContents } from 'electron'
import path from 'path'
import { cjsSiblingPreloadPath, hostToolbarPreloadPath, mainPreloadPath } from '../../utils/paths.js'
import {
  applyNavigationHardening,
  handleWindowOpenExternal,
} from '../../windows/navigation-hardening.js'
import type { RenderEvent } from '../../ipc/bridge-router.js'
import { SimulatorCustomApiBridgeChannel } from '../../../shared/ipc-channels.js'
import type { NativeDeviceInfo } from '../../../shared/ipc-channels.js'
import {
  OPEN_IN_EDITOR_SCHEME,
  decodeOpenInEditorUrl,
  resourceUrlToProjectRelativePath,
} from '../../../shared/open-in-editor.js'
import { createSafeAreaController } from '../safe-area/index.js'
import { buildCustomizeTabsScript } from './devtools-tabs.js'
import { installElementsForward } from '../elements-forward/index.js'
import * as layout from '../layout/index.js'
import {
  handleCustomApiBridgeRequest,
  type CustomApiBridgeRequest,
} from '../simulator/custom-apis.js'
import { getDefaultTab, type WorkbenchContext } from '../workbench-context.js'
import { configureMiniappSession, miniappPartition } from './miniapp-partition.js'
import { parseRoute } from '../../../shared/simulator-route.js'

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
  /**
   * Absolute path to the simulator preload bundle. Only consumed by the
   * native-host simulator WebContentsView (`attachNativeSimulator`); the
   * default `<webview>` path gets its preload from the session-registered
   * frame preload instead. Optional so partial test contexts compile.
   */
  preloadPath?: string
  panels: string[]
  notify: WorkbenchContext['notify']
  bridge?: WorkbenchContext['bridge']
  /**
   * Native-host network forwarder. `attachNativeSimulator` hands it the freshly
   * created simulator WebContentsView (`attachSimulator`) so it can attach the
   * CDP debugger, and the DevTools front-end host wc (`setDevtoolsHost`) so it can
   * inject that WCV's Network.* events into the native Network tab (service-host
   * console line is the fallback). Optional so partial test contexts compile.
   */
  networkForward?: WorkbenchContext['networkForward']
  /**
   * Per-context registry of host-registered simulator custom APIs. The
   * native-host simulator is a top-level WebContentsView with no embedder
   * renderer, so `attachNativeSimulator` dispatches the simulator-side
   * `__diminaCustomApis` bridge straight to this registry (the default
   * `<webview>` path proxies through the trusted main renderer instead).
   * Optional so partial test contexts compile.
   */
  simulatorApis?: WorkbenchContext['simulatorApis']
  /**
   * Header bar height in px, used to position overlay views below the header.
   * Optional here so partial test contexts compile; `createWorkbenchContext`
   * always supplies it (default 40).
   */
  headerHeight?: number
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
 * The code editor is NOT an overlay: it renders as an in-renderer
 * `<MonacoEditor/>` React component inside the main window. The main
 * window's own renderer is the content root and is not managed here.
 */
export interface ViewManager {
  // ── DevTools ───────────────────────────────────────────────────────────
  /**
   * Create a DevTools view for the given simulator webContents and add it to
   * the main window contentView (only when the `devtools` tab is the default
   * tab; otherwise the view is created but not added yet).
   */
  attachSimulator(simWcId: number, simWidth: number): void
  /**
   * NATIVE-HOST ONLY. Create the simulator itself as a top-level
   * WebContentsView (not a renderer `<webview>` guest) loading `simulatorUrl`,
   * position it in the simulator panel region, and treat its webContents as
   * THE simulator webContents (so `getSimulatorWebContents` resolves it and the
   * spawn/SIMULATOR_EVENTS pipeline flows through it). This is required because
   * Electron force-disables the `<webview>` tag inside a webview guest, so the
   * default `<webview>`-in-`<webview>` topology can never host DeviceShell's
   * per-page render-host `<webview>`s. A top-level WebContentsView's webContents
   * is NOT a guest and CAN host them. Then wires the DevTools/console view on
   * top of it via `attachSimulator`. No-op (logs) when `preloadPath` is unset.
   */
  attachNativeSimulator(simulatorUrl: string, simWidth: number): void
  /**
   * Destroy and null out the simulator view (e.g. on simulator detach).
   * Also destroys the cached settings view and hides the popover —
   * preserves the aggregate `detachAllViews` behaviour of the previous
   * `windows/views.ts` module, which every detach call relied on.
   */
  detachSimulator(): void
  /** Reveal the existing DevTools view (idempotent). */
  showSimulator(simWidth: number): void
  /** Remove (but do not destroy) the simulator view from the contentView. */
  hideSimulator(): void

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
  /** Return the last known simulator width. */
  getLastSimWidth(): number
  /** Whether the simulator overlay is currently added to the contentView. */
  isSimulatorAdded(): boolean
  /** Whether a DevTools view exists (created but maybe not added). */
  hasSimulatorView(): boolean
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
  /** Update lastSimWidth; reposition simulator + settings if they are added. */
  resize(simWidth: number): void
  /** Show or hide the simulator overlay based on visibility flag. */
  setVisible(visible: boolean, simWidth: number): void

  // ── Renderer-driven overlay bounds ────────────────────────────────────
  /**
   * Apply a renderer-measured rectangle to the simulator's Chromium
   * DevTools overlay view. `{ width: 0, height: 0 }` is treated as "hide" —
   * the view is removed from the contentView but its WebContents is kept
   * alive so re-showing it doesn't re-pay the DevTools bootstrap.
   */
  setSimulatorDevtoolsBounds(bounds: { x: number; y: number; width: number; height: number }): void

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
   * its intrinsic content height (block-axis extent); we store it and push it
   * to the main-window renderer so the placeholder div resizes (closing the
   * dynamic-height loop).
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
   * Override the preload used when the toolbar view is first created. The
   * host-shell (`launch(config)`) passes the host-controlled
   * `toolbar.preloadPath` here; the host owns the bridge (it calls
   * `exposeWorkbenchBridge()` itself). Must be set before the first
   * `loadURL`/`loadFile`; `null` restores the built-in size-advertiser preload.
   */
  setPreloadPath(path: string | null): void
}

/**
 * Build a ViewManager bound to the given context. The returned object is the
 * only component allowed to instantiate or add/remove overlay WebContentsViews.
 *
 * All view-related mutable state lives inside this closure and is not exposed
 * on the context object.
 */
export function createViewManager(ctx: ViewManagerContext): ViewManager {
  // Resolve once: full WorkbenchContext always provides headerHeight; partial
  // test contexts may omit it, in which case fall back to the default 40.
  const headerHeight = ctx.headerHeight ?? 40

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
  let lastSimWidth = 375
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
  let nativeDevtoolsRetryTimer: ReturnType<typeof setTimeout> | null = null
  let nativeDevtoolsRetryToken = 0

  // Renderer-driven overlay bounds for the simulator DevTools view. When
  // non-null this takes precedence over the legacy layout computed from the
  // window content size. A zero-area rectangle means "hide" — the overlay is
  // removed from the contentView but its WebContents stays alive.
  let simulatorBoundsOverride: layout.Bounds | null = null

  // ── Host-controllable toolbar WebContentsView ───────────────────────────
  // A strip above the devtools header that the downstream host loads its own
  // content into and fully controls. Bounds come from a renderer DOM anchor
  // (forward anchor, like the simulator DevTools overlay); its height is
  // dynamic via a reverse size-advertiser the toolbar's own renderer drives.
  let hostToolbarView: WebContentsView | null = null
  let hostToolbarPreloadOverride: string | null = null
  let hostToolbarViewAdded = false

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

  function applySimulatorBounds(simWidth: number): void {
    if (!simulatorView || ctx.windows.mainWindow.isDestroyed()) return
    if (simulatorBoundsOverride) {
      simulatorView.setBounds(simulatorBoundsOverride)
      return
    }
    const [w = 0, h = 0] = ctx.windows.mainWindow.getContentSize()
    simulatorView.setBounds(
      layout.computeSimulatorBounds(w, h, simWidth, headerHeight),
    )
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
    }
    simulatorView.setBounds(bounds)
  }

  // ── Host-controllable toolbar WebContentsView ───────────────────────────

  // Lazily create the host-toolbar view. Mirrors `showSettings` for the
  // webPreferences shape and the native simulator for nav hardening +
  // background color (the host may load arbitrary URLs / content). Idempotent.
  function ensureHostToolbarView(): WebContentsView {
    if (hostToolbarView && !hostToolbarView.webContents.isDestroyed()) {
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
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        // Default: the reverse size-advertiser preload that measures the host
        // content's intrinsic height and posts it on the advertise channel so
        // main reserves exactly that strip height (dynamic height via
        // ViewAnchor). When the host-shell supplies its own toolbar preload
        // (workbench config.toolbar.preloadPath), use that instead — the host
        // owns the bridge and may install the advertiser itself.
        preload: hostToolbarPreloadOverride ?? hostToolbarPreloadPath,
      },
    })
    hostToolbarView = view
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
      if (hostToolbarView && hostToolbarViewAdded && !hostToolbarView.webContents.isDestroyed()) {
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

  function setHostToolbarHeight(extent: number): void {
    // Push the reserved height back to the main-window renderer so its
    // placeholder div resizes (closing the dynamic-height loop). The height is
    // not retained in main — the renderer placeholder is the single source of
    // truth, and the forward anchor re-reports bounds from it.
    ctx.notify.hostToolbarHeightChanged(extent)
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
    ctx.notify.hostToolbarHeightChanged(0)
  }

  const hostToolbar: HostToolbarControl = {
    async loadURL(url: string): Promise<void> {
      const view = ensureHostToolbarView()
      await view.webContents.loadURL(url)
    },
    async loadFile(filePath: string): Promise<void> {
      const view = ensureHostToolbarView()
      await view.webContents.loadFile(filePath)
    },
    get webContents(): WebContents | null {
      if (!hostToolbarView) return null
      if (hostToolbarView.webContents.isDestroyed()) return null
      return hostToolbarView.webContents
    },
    hide(): void {
      hideHostToolbar()
    },
    setPreloadPath(path: string | null): void {
      hostToolbarPreloadOverride = path
    },
  }

  function applySettingsBounds(): void {
    if (!settingsView || ctx.windows.mainWindow.isDestroyed()) return
    const [w = 0, h = 0] = ctx.windows.mainWindow.getContentSize()
    settingsView.setBounds(layout.computeSettingsBounds(w, h, headerHeight))
  }

  function applyPopoverBounds(): void {
    if (!popoverView || ctx.windows.mainWindow.isDestroyed()) return
    const [w = 0, h = 0] = ctx.windows.mainWindow.getContentSize()
    popoverView.setBounds(layout.computePopoverBounds(w, h, headerHeight))
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

  // ── Open-in-editor: click a console file link → built-in Monaco ──────────
  // The right-panel console is the embedded Chromium DevTools front-end. Once a
  // sourcemap maps a console frame back to source (restored by the service-host
  // importScripts sourcemap rewrite), we redirect a source-link click to OUR
  // Monaco editor instead of the DevTools Sources panel: install an "open
  // resource handler" in the front-end realm that encodes (url, line, col) into
  // a sentinel URL and asks the front-end to open it; Electron surfaces that as
  // `devtools-open-url` on the inspected (service-host) wc, which we decode,
  // map to a project-relative path, and broadcast to the renderer's Monaco.
  const openInEditorWiredWcIds = new Set<number>()

  function injectOpenResourceHandler(devtoolsWc: WebContents): void {
    // `setOpenResourceHandler` is the official Chromium DevTools hook IDEs use
    // to route source-link clicks to an external editor. We poll for the host
    // (it appears once the front-end finishes bootstrapping, like `UI` above)
    // and register a handler that re-emits an encoded sentinel via
    // `openInNewTab` → Electron `devtools-open-url`. Best-effort: wrapped in
    // try/catch and a bounded poll so a missing API never throws.
    const scheme = JSON.stringify(OPEN_IN_EDITOR_SCHEME)
    devtoolsWc.executeJavaScript(`
      (function() {
        try {
          let tries = 0
          const timer = setInterval(() => {
            tries++
            try {
              const Host = globalThis.Host
              const host = Host && Host.InspectorFrontendHost
              if (host && typeof host.setOpenResourceHandler === 'function'
                       && typeof host.openInNewTab === 'function') {
                host.setOpenResourceHandler((url, lineNumber, columnNumber) => {
                  try {
                    const p = new URLSearchParams()
                    p.set('u', String(url))
                    if (typeof lineNumber === 'number') p.set('l', String(lineNumber))
                    if (typeof columnNumber === 'number') p.set('c', String(columnNumber))
                    host.openInNewTab(${scheme} + ':?' + p.toString())
                  } catch (_) {}
                })
                clearInterval(timer)
                return
              }
            } catch (_) {}
            if (tries > 80) clearInterval(timer)
          }, 50)
        } catch (_) {}
      })()
    `).catch(() => {})
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
        devtoolsWc.once('dom-ready', () => injectOpenResourceHandler(devtoolsWc))
      } else {
        injectOpenResourceHandler(devtoolsWc)
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
      const rel = resourceUrlToProjectRelativePath(req.url)
      if (!rel) return
      // DevTools reports 0-based line/column; Monaco is 1-based.
      const line = typeof req.line === 'number' ? req.line + 1 : undefined
      const column = typeof req.column === 'number' ? req.column + 1 : undefined
      ctx.notify.editorOpenFile({ path: rel, line, column })
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
      // Redirect console source-link clicks to the built-in Monaco editor.
      wireOpenInEditor(next, simulatorView.webContents)
      // Keep only Elements/Console/Network tabs (front-most, in that order).
      // Re-applied on every re-point so a service-host pool swap (fresh
      // openDevTools) re-asserts the custom tab bar.
      customizeDevtoolsTabs(simulatorView.webContents)
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

  function attachSimulator(simWcId: number, simWidth: number): void {
    const sim = webContents.fromId(simWcId)
    if (!sim) {
      console.error('[workbench] attachSimulator — simWc not found for id', simWcId)
      return
    }
    lastSimWidth = simWidth
    simulatorWebContentsId = simWcId

    // Destroy old simulatorView to prevent WebContentsView leak
    if (simulatorView) {
      hideSimulator()
      try {
        if (!simulatorView.webContents.isDestroyed()) {
          simulatorView.webContents.close()
        }
      } catch { /* ignore */ }
      simulatorView = null
    }

    simulatorView = new WebContentsView()
    sim.setDevToolsWebContents(simulatorView.webContents)
    // Embedded in the right-panel host view; never bring it to the foreground
    // (would steal focus from the user / disrupt e2e).
    sim.openDevTools({ mode: 'detach', activate: false })

    // Default DevTools to Console panel (Chrome DevTools defaults to Elements).
    // The DevTools UI lives inside closed shadow roots, so a light-DOM
    // querySelector('[role="tab"]') cannot reach the tab bar to click it.
    // Instead drive the front-end's own view manager: the bundled DevTools
    // exposes `UI.ViewManager.instance().showView(id)` on `globalThis.UI`
    // once the front-end has finished bootstrapping. We poll for it and
    // request the `console` view, and also persist the choice via the
    // `panel-selectedTab` localStorage key so subsequent reloads honor it.
    const devtoolsWc = simulatorView.webContents
    // Keep only Elements/Console/Network tabs (front-most, in that order).
    customizeDevtoolsTabs(devtoolsWc)
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

    if (getDefaultTab(ctx) === 'simulator') {
      if (simulatorBoundsOverride) {
        if (!isHidden(simulatorBoundsOverride)) {
          ctx.windows.mainWindow.contentView.addChildView(simulatorView)
          simulatorViewAdded = true
          simulatorView.setBounds(simulatorBoundsOverride)
        }
      } else {
        ctx.windows.mainWindow.contentView.addChildView(simulatorView)
        simulatorViewAdded = true
        applySimulatorBounds(simWidth)
      }
    }
  }

  function attachNativeSimulatorDevtoolsHost(simWidth: number): void {
    stopFollowingNativeServiceHost()

    // Destroy old simulatorView to prevent WebContentsView leak
    if (simulatorView) {
      hideSimulator()
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
      stopElementsForward = installElementsForward({ devtoolsWc, bridge: ctx.bridge, connections: ctx.connections })
      devtoolsWc.once('destroyed', () => {
        try { stopElementsForward?.() } catch { /* already stopped */ }
        stopElementsForward = null
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

    if (getDefaultTab(ctx) === 'simulator') {
      if (simulatorBoundsOverride) {
        if (!isHidden(simulatorBoundsOverride)) {
          ctx.windows.mainWindow.contentView.addChildView(simulatorView)
          simulatorViewAdded = true
          simulatorView.setBounds(simulatorBoundsOverride)
        }
      } else {
        ctx.windows.mainWindow.contentView.addChildView(simulatorView)
        simulatorViewAdded = true
        applySimulatorBounds(simWidth)
      }
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

  function attachNativeSimulator(simulatorUrl: string, simWidth: number): void {
    if (!ctx.preloadPath) {
      console.error('[workbench] attachNativeSimulator — preloadPath unset; cannot mount native simulator')
      return
    }
    lastSimWidth = simWidth

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
          nativeSimulatorView.webContents.close()
        }
      } catch { /* ignore */ }
      nativeSimulatorView = null
    }

    // Derive THIS project's session partition from the simulator URL's appId so
    // its cookies/localStorage/cache are isolated from every other project (P0
    // debt). Same project → same partition (storage survives a relaunch);
    // unknown appId → the shared fallback. Configure the partition's session
    // (protocol handlers + CORS/referer policy) before any project content loads
    // on it — idempotent per partition.
    const route = parseRoute(simulatorUrl)
    const partition = miniappPartition(route?.appId)
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
    // Paint the WCV surface the simulator-panel background (≈ --color-sim-bg
    // hsl(0 0% 7%)) so a height-resize that grows the region never flashes white
    // in the newly-exposed strip before DeviceShell's desk repaints — the WCV,
    // the desk, and the renderer placeholder behind it are all the same color.
    view.setBackgroundColor('#121212')
    const simWc = view.webContents

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
    simWc.on('will-attach-webview', (_event, webPreferences, params) => {
      ;(webPreferences as Electron.WebPreferences).partition = partition
      params.partition = partition
      webPreferences.contextIsolation = false
      ;(webPreferences as Electron.WebPreferences).sandbox = false
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
      // before it paints, so notch-aware page layout resolves correctly.
      safeArea.applyToGuest(guestWc, ctx.bridge?.getDevice() ?? null)
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
    attachNativeSimulatorDevtoolsHost(simWidth)
  }

  function detachSimulator(): void {
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
    // Drop the renderer-published rect so a stale "hidden" override doesn't
    // suppress the next view before its renderer republishes.
    simulatorBoundsOverride = null
    // Also drop the cached native-simulator rect: attachNativeSimulator replays
    // lastRendererRect on attach, so a leftover rect/offset from a torn-down
    // session must not be replayed onto a fresh re-attach (stale slice/offset).
    lastRendererRect = null
  }

  function showSimulator(simWidth: number): void {
    lastSimWidth = simWidth
    if (!simulatorView) return
    if (!simulatorViewAdded) {
      ctx.windows.mainWindow.contentView.addChildView(simulatorView)
      simulatorViewAdded = true
    }
    applySimulatorBounds(simWidth)
  }

  function hideSimulator(): void {
    if (simulatorView && simulatorViewAdded) {
      try {
        ctx.windows.mainWindow.contentView.removeChildView(simulatorView)
      } catch (e) {
        console.error('[workbench] hideSimulator error', e)
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
    // Native simulator: bounds owned by the renderer's reportBounds (Model A);
    // its window-resize listener re-measures, so no coarse re-apply here.
    if (simulatorView && simulatorViewAdded)
      applySimulatorBounds(lastSimWidth)
    if (settingsView && settingsViewAdded)
      applySettingsBounds()
    if (popoverView)
      applyPopoverBounds()
  }

  function disposeAll(): void {
    detachSimulator()
    // Host-controllable toolbar view: removed from the contentView + its
    // WebContents closed (the host's loaded content is torn down on app exit).
    destroyViewInternal(hostToolbarView)
    hostToolbarView = null
    hostToolbarViewAdded = false
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

  function resize(simWidth: number): void {
    lastSimWidth = simWidth
    // Native simulator bounds are owned solely by the renderer's reportBounds
    // (Model A) — its ResizeObserver/window-resize listeners re-measure on this
    // same resize. No coarse panel-size re-apply here (it raced the precise rect).
    if (simulatorViewAdded) applySimulatorBounds(simWidth)
    if (settingsViewAdded) applySettingsBounds()
  }

  function setVisible(visible: boolean, simWidth: number): void {
    lastSimWidth = simWidth
    if (!simulatorView) return

    if (visible && !simulatorViewAdded) {
      showSimulator(simWidth)
    } else if (!visible) {
      hideSimulator()
    }
  }

  return {
    attachSimulator,
    attachNativeSimulator,
    detachSimulator,
    reapplySafeArea: (device) => safeArea.reapplyAll(device),
    showSimulator,
    hideSimulator,
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
    getLastSimWidth: () => lastSimWidth,
    isSimulatorAdded: () => simulatorViewAdded,
    hasSimulatorView: () => simulatorView !== null,
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
    getHostToolbarWebContentsId: () => {
      if (!hostToolbarView) return null
      if (hostToolbarView.webContents.isDestroyed()) return null
      return hostToolbarView.webContents.id
    },
    setNativeSimulatorViewBounds,
    resize,
    setVisible,
    setSimulatorDevtoolsBounds,
    setHostToolbarBounds,
    setHostToolbarHeight,
    hostToolbar,
  }
}
