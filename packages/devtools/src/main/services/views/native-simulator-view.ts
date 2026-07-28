import type { IpcMainEvent, WebContents } from 'electron'
import { ipcMain, nativeTheme, shell, WebContentsView, webContents } from 'electron'
import { cjsSiblingPreloadPath } from '../../utils/paths.js'
import { simDeskBg } from '../../utils/theme.js'
import { handleWindowOpenExternal } from '../../windows/navigation-hardening.js'
import { SimulatorCustomApiBridgeChannel } from '../../../shared/ipc-channels.js'
import * as layout from '../layout/index.js'
import {
  handleCustomApiBridgeRequest,
  type CustomApiBridgeRequest,
} from '../simulator/custom-apis.js'
import type { SafeAreaController } from '../safe-area/index.js'
import { configureMiniappSession, miniappPartition } from './miniapp-partition.js'
import { refreshGuestStylesheets } from './refresh-styles.js'
import { parseRoute } from '../../../shared/simulator-route.js'
import { SIMULATOR_EVENTS } from '../../../shared/bridge-channels.js'
import type { RelaunchPayload } from '../../../shared/bridge-channels.js'
import { VIEW_ID } from '../../../shared/view-ids.js'
import type { DevtoolsHost } from './native-simulator-devtools-host.js'
import type { OverlayPanelsView } from './overlay-panels-view.js'
import type { PlacementReconciler } from './placement-reconciler.js'
import type { ViewManagerContext } from './view-manager.js'

/**
 * NATIVE-HOST ONLY. The native simulator is a top-level WebContentsView (the
 * DeviceShell host) that IS the simulator webContents, so bridge-router resolves
 * `ap.simulatorWc = event.sender = this wc` and SIMULATOR_EVENTS flow through
 * it. It hosts per-page render-host `<webview>`s (impossible under a `<webview>`
 * guest — the whole point of Option A). Its DevTools live in the right panel
 * (the separate DevtoolsHost).
 */
export interface NativeSimulatorView {
  attachNativeSimulator(simulatorUrl: string, simWidth: number): Promise<void>
  softReloadNativeSimulator(simulatorUrl: string): boolean
  /**
   * Hot-swap stylesheets in every live render-host guest WITHOUT respawning the
   * shell (page stack / form state / focus survive). Returns false when no live
   * guest exists, so the caller falls back to a full reload.
   */
  refreshSimulatorStyles(): boolean
  detachSimulator(): void
  getSimulatorWebContentsId(): number | null
  getSimulatorWebContents(): WebContents | null
  getSimulatorProjectPath(): string | null
}

export function createNativeSimulatorView(
  ctx: ViewManagerContext,
  reconciler: PlacementReconciler,
  deps: {
    safeArea: SafeAreaController
    devtoolsHost: DevtoolsHost
    overlayPanels: OverlayPanelsView
  },
): NativeSimulatorView {
  const { safeArea, devtoolsHost, overlayPanels } = deps

  let nativeSimulatorView: WebContentsView | null = null
  let nativeSimulatorViewAdded = false
  let nativeSimulatorProjectPath: string | null = null
  let settleNativeSimulatorReady: (() => void) | null = null
  // Whether the CURRENT simulator view's shell finished its first boot (first
  // render guest did-finish-load) — the precondition for a soft reload: only a
  // fully-booted shell has the RELAUNCH listener installed, so sending earlier
  // would silently drop the event and strand the renderer (it was told
  // "accepted" but nothing reloads). Reset on teardown/re-attach — readiness
  // never carries over to a rebuilt view.
  let nativeSimulatorShellReady = false
  // The `ipcMain.on` listener that services the `__diminaCustomApis` bridge for
  // the current native simulator webContents (see `attachNativeCustomApiBridge`).
  // Tracked so we can remove it before tearing down / re-attaching the view
  // (otherwise listeners leak across relaunch cycles).
  let nativeCustomApiBridgeHandler: ((event: IpcMainEvent, req: unknown) => void) | null = null
  // The current device zoom as a factor (zoomPercent/100), last reported by the
  // renderer via setNativeSimulatorViewBounds. Stored so nested render-host
  // `<webview>` guests attached AFTER a zoom change still pick up the correct
  // scale in `did-attach-webview`. Defaults to 1 (100%).
  let currentZoomFactor = 1
  let simulatorWebContentsId: number | null = null

  // simulator zoom rides in `extra`: setBounds also drives the WCV zoomFactor and
  // propagates it to nested render-host guests.
  function applyNativeSimulatorBounds(
    view: WebContentsView,
    bounds: layout.Bounds,
    zoom: number,
  ): void {
    const p = layout.computeNativeSimulatorViewParams(bounds, zoom)
    currentZoomFactor = p.zoomFactor
    view.setBounds(p.bounds)
    const simWc = view.webContents
    if (!simWc.isDestroyed()) simWc.setZoomFactor(p.zoomFactor)
    try {
      for (const wc of webContents.getAllWebContents()) {
        if (wc.isDestroyed()) continue
        if (wc.hostWebContents === simWc) wc.setZoomFactor(p.zoomFactor)
      }
    } catch { /* hostWebContents unavailable; guests get zoom on attach */ }
  }

  /**
   * The single teardown path for the live native-host simulator WCV, shared by
   * relaunch (attachNativeSimulator replacing the view) and project close
   * (detachSimulator). Detaches the view from the window, then synchronously
   * clears its bridge sessions (render guests + service host + mappings) BEFORE
   * the WCV's own async close(), so the next project never re-resolves,
   * re-renders, or screenshots the outgoing guest. The sync prefix clears the
   * maps immediately; the async tail (pool / resource-server release) is observed
   * so a rejection is logged rather than swallowed. The simulatorWc 'destroyed'
   * hook in bridge-router stays as an idempotent fallback. No-op when no view is
   * live; idempotent (disposeSessionsForSimulator early-returns once a session is
   * gone), so the eager teardown here and the 'destroyed' fallback never
   * double-dispose. `label` only tags the diagnostic on the async-tail failure.
   */
  function tearDownNativeSimulatorView(label: string): void {
    if (!nativeSimulatorView) return
    if (nativeSimulatorViewAdded && !ctx.windows.mainWindow.isDestroyed()) {
      try {
        ctx.windows.mainWindow.contentView.removeChildView(nativeSimulatorView)
      } catch { /* already removed */ }
    }
    try {
      if (!nativeSimulatorView.webContents.isDestroyed()) {
        ctx.bridge?.disposeSessionsForSimulator?.(nativeSimulatorView.webContents.id)
          ?.catch((err) => console.warn(`[view-manager] dispose sessions (${label}) failed:`, err))
        nativeSimulatorView.webContents.close()
      }
    } catch { /* ignore */ }
    nativeSimulatorView = null
    nativeSimulatorViewAdded = false
    nativeSimulatorShellReady = false
    // The instance is being replaced/destroyed — forget its reconciled mount
    // state so the NEXT rebuilt view is treated as a fresh attach. Without this,
    // the level-triggered reconciler still records `simulator` as `attached`
    // (the manual removeChildView above bypasses it), so the next reconcile
    // classifies the freshly-built WebContentsView as already-attached, never
    // emits the `attach` op, and the new view is never addChildView'd — a sticky
    // 100%-invisible simulator after every recompile. Mirrors the hostToolbar
    // instance-replacement handling in ensureHostToolbarView.
    reconciler.forgetActual(VIEW_ID.simulator)
    // The view is gone: gateReadiness now hides it, so reconcile detaches it.
    reconciler.reconcileNow()
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
    // Consolidate this per-webContents teardown onto the connection layer:
    // acquiring the simWc connection makes the
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

    // Tear down any previous native simulator view (relaunch / re-open) through
    // the shared single teardown path. detachNativeCustomApiBridge stays here
    // (the bridge dispatcher is re-installed per attach below).
    if (nativeSimulatorView) {
      detachNativeCustomApiBridge()
      tearDownNativeSimulatorView('relaunch')
    }
    nativeSimulatorProjectPath = null

    const ready = new Promise<void>((resolve) => {
      settleNativeSimulatorReady = resolve
    })

    // Derive THIS project's session partition from the simulator URL's appId so
    // its cookies/localStorage/cache are isolated from every other project.
    // Same project → same partition (storage survives a relaunch);
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
      // Page-level resource loads (images/fonts/page fetch) run in THIS guest's
      // network stack, never the simulator's — without this, only wx.request
      // (forwarded to the simulator) shows in the Network panel and everything
      // the page itself loads is invisible. Shares the already-attached
      // safe-area debugger session (never a second attach/detach owner).
      ctx.networkForward?.attachRenderGuest(guestWc)
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
        // A loaded render guest means the shell booted end-to-end — from here
        // on a soft reload (RELAUNCH into this live shell) is deliverable.
        nativeSimulatorShellReady = true
        settleNativeSimulatorReady?.()
        settleNativeSimulatorReady = null
      })
      // A render-host guest only attaches after a spawn, so the service window
      // exists by now — (re)point the right-panel DevTools at it. Belt-and-braces
      // with the `onRenderEvent` path in case its emit lost the attach race.
      devtoolsHost.followServiceHost()
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

    // Model A: bounds come ONLY from the renderer's window-level placement
    // snapshot. The view now exists, so re-reconcile: gateReadiness admits the
    // simulator (gated hidden while its WCV was absent) and the latest desired
    // placement attaches + sizes it. Until the next snapshot it stays unadded.
    reconciler.reconcileNow()

    // Native-host page code (console.log / wx.request / Sources) runs in the
    // hidden SERVICE HOST window, not this DeviceShell host nor the render-host
    // guests. Keep the right-panel DevTools host view stable and point it at the
    // service host so its Console/Network(fetch)/Sources reflect the logic layer.
    // (The UI/view layer's Elements equivalent is the native WXML panel +
    // render-guest highlight chain, which targets the active render guest.)
    devtoolsHost.attach()
    return ready
  }

  function softReloadNativeSimulator(simulatorUrl: string): boolean {
    if (!nativeSimulatorView || nativeSimulatorView.webContents.isDestroyed()) return false
    if (!nativeSimulatorShellReady) return false
    const payload: RelaunchPayload = { url: simulatorUrl }
    nativeSimulatorView.webContents.send(SIMULATOR_EVENTS.RELAUNCH, payload)
    return true
  }

  /**
   * Style-only hot swap: cache-bust every render-host stylesheet in place so a
   * recompiled `.css` re-applies against the already-mounted page WITHOUT
   * respawning the DeviceShell — page stack / form state / scroll / focus all
   * survive (unlike `softReloadNativeSimulator`, which reboots the app session).
   * Returns false when the shell isn't ready or no guest is live, so the caller
   * falls back to a full reload rather than silently swallowing the rebuild.
   */
  function refreshSimulatorStyles(): boolean {
    const view = nativeSimulatorView
    if (!view || view.webContents.isDestroyed() || !nativeSimulatorShellReady) return false
    return refreshGuestStylesheets(view)
  }

  function detachSimulator(): void {
    settleNativeSimulatorReady?.()
    settleNativeSimulatorReady = null
    devtoolsHost.stopFollowing()
    detachNativeCustomApiBridge()
    // Stop Elements forwarding (detaches only the debugger sessions IT attached;
    // safe-area's sessions are untouched). Idempotent — the host 'destroyed'
    // handler may have already run.
    devtoolsHost.stopElementsForwarding()
    // Stop forwarding the simulator WCV's network (its debugger is detached as
    // the view is closed below, but drop our session deterministically first).
    // Also drop the DevTools front-end host — its wc is destroyed below; a stale
    // ref would make the forwarder dispatch into a dead wc instead of falling
    // back to the console.
    ctx.networkForward?.detachSimulator()
    ctx.networkForward?.setDevtoolsHost(null)
    // Native-host simulator content view (no-op in the default path) — same
    // single teardown path as relaunch. detachNativeCustomApiBridge was already
    // called above.
    tearDownNativeSimulatorView('close')
    overlayPanels.hidePopover()
    // Drop the settings view too — the previous detachAllViews() did.
    overlayPanels.destroySettings()
    // Destroy the right-panel DevTools front-end host — its wc is closed here.
    devtoolsHost.destroyHostView()
    simulatorWebContentsId = null
    nativeSimulatorProjectPath = null
  }

  reconciler.registerView(VIEW_ID.simulator, {
    getView: () => nativeSimulatorView,
    setAdded: (added) => { nativeSimulatorViewAdded = added },
    gateHidden: () => !nativeSimulatorView,
    applyBounds: (view, bounds, extra) => applyNativeSimulatorBounds(view, bounds, extra?.zoom ?? 1),
  })

  return {
    attachNativeSimulator,
    softReloadNativeSimulator,
    refreshSimulatorStyles,
    detachSimulator,
    getSimulatorWebContentsId: () => simulatorWebContentsId,
    getSimulatorWebContents: () => {
      if (simulatorWebContentsId == null) return null
      const wc = webContents.fromId(simulatorWebContentsId)
      return wc && !wc.isDestroyed() ? wc : null
    },
    getSimulatorProjectPath: () => nativeSimulatorProjectPath,
  }
}
