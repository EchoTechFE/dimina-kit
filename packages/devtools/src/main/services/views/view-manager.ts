import type { WebContents } from 'electron'
import { shell, WebContentsView, webContents } from 'electron'
import path from 'path'
import { cjsSiblingPreloadPath, mainPreloadPath } from '../../utils/paths.js'
import {
  applyNavigationHardening,
  handleWindowOpenExternal,
} from '../../windows/navigation-hardening.js'
import type { RenderEvent } from '../../ipc/bridge-router.js'
import * as layout from '../layout/index.js'
import { getDefaultTab, type WorkbenchContext } from '../workbench-context.js'

/**
 * Context surface used by the ViewManager. We only need a small slice of the
 * full WorkbenchContext here; typing it this way documents the actual dependency.
 */
export interface ViewManagerContext {
  windows: WorkbenchContext['windows']
  rendererDir: string
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

  // ── Compound operations (used by IPC handlers) ────────────────────────
  /**
   * NATIVE-HOST ONLY. Position the simulator content WebContentsView over the
   * renderer-measured device-bezel inner-screen rect (CSS px from the main
   * window content top-left, which maps 1:1 to overlay setBounds DIP) and apply
   * the device zoom. No-op in the default `<webview>` path
   * (`nativeSimulatorView` is null). See `computeNativeSimulatorViewParams`.
   */
  setNativeSimulatorViewBounds(params: { x: number; y: number; width: number; height: number; zoom: number }): void
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

  // ── Private mutable state ───────────────────────────────────────────────
  let simulatorView: WebContentsView | null = null
  let simulatorViewAdded = false
  // NATIVE-HOST ONLY: the simulator content WebContentsView (the DeviceShell
  // host). In the default path the simulator is a renderer `<webview>` and this
  // stays null. Positioned in the simulator panel region (left of the splitter)
  // while `simulatorView` above hosts its DevTools in the right panel region.
  let nativeSimulatorView: WebContentsView | null = null
  let nativeSimulatorViewAdded = false
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
  let nativeDevtoolsSourceWc: WebContents | null = null
  let nativeDevtoolsSourceBridgeId: string | null = null
  let unsubscribeNativeRenderEvents: (() => void) | null = null
  let nativeDevtoolsRetryTimer: ReturnType<typeof setTimeout> | null = null
  let nativeDevtoolsRetryToken = 0

  // Renderer-driven overlay bounds for the simulator DevTools view. When
  // non-null this takes precedence over the legacy layout computed from the
  // window content size. A zero-area rectangle means "hide" — the overlay is
  // removed from the contentView but its WebContents stays alive.
  let simulatorBoundsOverride: layout.Bounds | null = null

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

  function applyNativeSimulatorBounds(simWidth: number): void {
    if (!nativeSimulatorView || ctx.windows.mainWindow.isDestroyed()) return
    const [w = 0, h = 0] = ctx.windows.mainWindow.getContentSize()
    nativeSimulatorView.setBounds(
      layout.computeNativeSimulatorBounds(w, h, simWidth, headerHeight),
    )
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
    nativeDevtoolsSourceBridgeId = null
    if (!source || source.isDestroyed()) return
    try {
      if (source.isDevToolsOpened()) {
        source.closeDevTools()
      }
    } catch { /* source may be mid-destroy */ }
  }

  function stopFollowingNativeRenderGuest(): void {
    clearNativeDevtoolsRetry()
    if (unsubscribeNativeRenderEvents) {
      try {
        unsubscribeNativeRenderEvents()
      } catch { /* ignore */ }
      unsubscribeNativeRenderEvents = null
    }
    closeNativeDevtoolsSource()
  }

  function pointNativeDevtoolsAtRenderGuest(
    bridgeId: string | null,
    next: WebContents,
  ): boolean {
    if (!simulatorView || simulatorView.webContents.isDestroyed()) return true
    if (nativeDevtoolsSourceWc?.id === next.id && !nativeDevtoolsSourceWc.isDestroyed()) {
      nativeDevtoolsSourceBridgeId = bridgeId
      return true
    }
    closeNativeDevtoolsSource()
    nativeDevtoolsSourceWc = next
    nativeDevtoolsSourceBridgeId = bridgeId

    try {
      next.setDevToolsWebContents(simulatorView.webContents)
      // DevTools renders into the right-panel host view (simulatorView); with a
      // custom host the `mode` is overridden, and `activate:false` prevents it
      // stealing focus — this re-points on every navigation, so a focusing
      // window would yank focus repeatedly (disrupting the user / e2e).
      next.openDevTools({ mode: 'detach', activate: false })
      return true
    } catch {
      if (nativeDevtoolsSourceWc?.id === next.id) {
        nativeDevtoolsSourceWc = null
        nativeDevtoolsSourceBridgeId = null
      }
      return false
    }
  }

  function resolveNativeDevtoolsTarget(appId?: string, bridgeId?: string): {
    activeBridgeId: string | null
    wc: WebContents | null
  } {
    const bridge = ctx.bridge
    if (!bridge?.isNativeHost()) return { activeBridgeId: null, wc: null }
    const activeBridgeId = bridge.getActiveBridgeId(appId)
    const targetBridgeId = bridgeId ?? activeBridgeId
    if (bridgeId && bridgeId !== activeBridgeId) {
      return { activeBridgeId, wc: null }
    }
    const exact = targetBridgeId ? bridge.resolveRenderWc(targetBridgeId) : null
    if (exact && !exact.isDestroyed()) return { activeBridgeId: targetBridgeId, wc: exact }
    const active = bridge.getActiveRenderWc(appId)
    return {
      activeBridgeId,
      wc: active && !active.isDestroyed() ? active : null,
    }
  }

  function pointNativeDevtoolsAtActiveRenderGuest(appId?: string, bridgeId?: string): boolean {
    if (!ctx.bridge?.isNativeHost()) return true
    if (!simulatorView || simulatorView.webContents.isDestroyed()) return true

    const { activeBridgeId, wc } = resolveNativeDevtoolsTarget(appId, bridgeId)
    if (activeBridgeId && nativeDevtoolsSourceBridgeId && nativeDevtoolsSourceBridgeId !== activeBridgeId) {
      closeNativeDevtoolsSource()
    }
    if (!wc || wc.isDestroyed()) return false
    return pointNativeDevtoolsAtRenderGuest(activeBridgeId, wc)
  }

  function scheduleNativeDevtoolsFollow(appId?: string, bridgeId?: string, attempt = 0): void {
    if (attempt >= 20) return
    if (!ctx.bridge?.isNativeHost()) return
    const token = nativeDevtoolsRetryToken
    if (nativeDevtoolsRetryTimer) clearTimeout(nativeDevtoolsRetryTimer)
    nativeDevtoolsRetryTimer = setTimeout(() => {
      nativeDevtoolsRetryTimer = null
      if (token !== nativeDevtoolsRetryToken) return
      if (pointNativeDevtoolsAtActiveRenderGuest(appId, bridgeId)) return
      scheduleNativeDevtoolsFollow(appId, bridgeId, attempt + 1)
    }, 50)
  }

  function followNativeDevtoolsRenderGuest(appId?: string, bridgeId?: string): void {
    clearNativeDevtoolsRetry()
    if (pointNativeDevtoolsAtActiveRenderGuest(appId, bridgeId)) return
    scheduleNativeDevtoolsFollow(appId, bridgeId)
  }

  function onNativeRenderEvent(event: RenderEvent): void {
    if (event.kind !== 'activePage' && event.kind !== 'domReady') return
    if (event.kind === 'domReady' && ctx.bridge?.getActiveBridgeId(event.appId) !== event.bridgeId) return
    followNativeDevtoolsRenderGuest(event.appId, event.bridgeId)
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
    stopFollowingNativeRenderGuest()

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
      followNativeDevtoolsRenderGuest()
    }
  }

  function attachNativeSimulator(simulatorUrl: string, simWidth: number): void {
    if (!ctx.preloadPath) {
      console.error('[workbench] attachNativeSimulator — preloadPath unset; cannot mount native simulator')
      return
    }
    lastSimWidth = simWidth

    // Tear down any previous native simulator view (relaunch / re-open).
    if (nativeSimulatorView) {
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

    // The simulator preload is a CJS bundle; webPreferences.preload obeys the
    // `.js` + "type":"module" ESM rule (require would be undefined), so hand the
    // top-level WebContentsView the `.cjs` sibling. contextIsolation:false +
    // sandbox:false + webviewTag:true mirror what the default `<webview>` guest
    // runs with, and `partition:'persist:simulator'` shares storage + the
    // session-registered preload/CORS rules with the rest of the simulator.
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: false,
        sandbox: false,
        webviewTag: true,
        preload: cjsSiblingPreloadPath(ctx.preloadPath),
        partition: 'persist:simulator',
      },
    })
    nativeSimulatorView = view
    const simWc = view.webContents

    // DeviceShell mounts per-page render-host `<webview>`s INSIDE this view.
    // Mirror windows/main-window/create.ts: pin them onto persist:simulator and
    // run them with contextIsolation/sandbox off so the render runtime + its
    // preload share the page realm. (A top-level WebContentsView can host these
    // guests; a `<webview>` guest cannot — that's the whole point of Option A.)
    simWc.on('will-attach-webview', (_event, webPreferences, params) => {
      ;(webPreferences as Electron.WebPreferences).partition = 'persist:simulator'
      params.partition = 'persist:simulator'
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
      followNativeDevtoolsRenderGuest()
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

    if (getDefaultTab(ctx) === 'simulator') {
      ctx.windows.mainWindow.contentView.addChildView(view)
      nativeSimulatorViewAdded = true
      applyNativeSimulatorBounds(simWidth)
    }

    // Native-host page code runs in the nested render-host guest, not this
    // DeviceShell host. Keep the right-panel DevTools host view stable, but
    // inspect whichever render-host guest the bridge reports as visible.
    attachNativeSimulatorDevtoolsHost(simWidth)
  }

  function detachSimulator(): void {
    stopFollowingNativeRenderGuest()
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
    if (nativeSimulatorView && nativeSimulatorViewAdded)
      applyNativeSimulatorBounds(lastSimWidth)
    if (simulatorView && simulatorViewAdded)
      applySimulatorBounds(lastSimWidth)
    if (settingsView && settingsViewAdded)
      applySettingsBounds()
    if (popoverView)
      applyPopoverBounds()
  }

  function disposeAll(): void {
    detachSimulator()
  }

  function setNativeSimulatorViewBounds(
    params: { x: number; y: number; width: number; height: number; zoom: number },
  ): void {
    if (!nativeSimulatorView || ctx.windows.mainWindow.isDestroyed()) return
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
    // setBorderRadius lands on WebContentsView in Electron 41; guard so a
    // missing method (older runtime / tests) doesn't crash positioning.
    const viewWithRadius = nativeSimulatorView as WebContentsView & {
      setBorderRadius?: (radius: number) => void
    }
    viewWithRadius.setBorderRadius?.(p.borderRadius)
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
    if (nativeSimulatorViewAdded) applyNativeSimulatorBounds(simWidth)
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
    setNativeSimulatorViewBounds,
    resize,
    setVisible,
    setSimulatorDevtoolsBounds,
  }
}
