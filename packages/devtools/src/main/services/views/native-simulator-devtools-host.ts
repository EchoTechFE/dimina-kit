import type { WebContents } from 'electron'
import { WebContentsView } from 'electron'
import {
  buildDevtoolsProjectSourceLinksScript,
  decodeOpenInEditorUrl,
  projectSourceContextFromServiceHostUrl,
} from '../../../shared/open-in-editor.js'
import type { RenderEvent } from '../../ipc/bridge-router.js'
import { buildCustomizeTabsScript } from './devtools-tabs.js'
import { installElementsForward } from '../elements-forward/index.js'
import { installServiceConsoleForward } from '../service-console/index.js'
import { VIEW_ID } from '../../../shared/view-ids.js'
import { resolveProjectEditorTarget } from './resolve-project-editor-target.js'
import { destroyChildView } from './destroy-child-view.js'
import { createLoadDeferredInjector } from './inject-when-ready.js'
import type { PlacementReconciler } from './placement-reconciler.js'
import type { ViewManagerContext } from './view-manager.js'

// `webContents.executeJavaScript()` registers a transient `did-stop-loading`
// listener on the target wc whenever that wc is still loading (Electron's
// `waitTillCanExecuteJavaScript` defers the eval until load finishes, then
// removes the listener). The DevTools front-end host wc takes a burst of injects
// during its boot window — tab customization, default-panel selection, the 150ms
// Elements-forward reconcile, and Network-forward probing all call
// `executeJavaScript()` on it before the front-end has finished loading — so the
// pending listeners can transiently exceed Node's default EventEmitter ceiling
// of 10 and print a spurious `MaxListenersExceededWarning: 11 did-stop-loading
// listeners`. They drain once the wc stops loading; this is a boot-time
// concurrency spike, not a per-event leak. Raise the ceiling on the DevTools
// host wc, which we knowingly inject into repeatedly during its boot window, so
// the benign spike stays quiet. (Confirmed at runtime: the tripped emitter is
// this host wc's `did-stop-loading`, count 11 — see the `process.on('warning')`
// diagnostic in app bootstrap.)
const DEVTOOLS_HOST_EXEC_JS_MAX_LISTENERS = 50

function raiseExecuteJavaScriptListenerCeiling(wc: WebContents): void {
  try {
    if (wc.isDestroyed()) return
    if (wc.getMaxListeners() >= DEVTOOLS_HOST_EXEC_JS_MAX_LISTENERS) return
    wc.setMaxListeners(DEVTOOLS_HOST_EXEC_JS_MAX_LISTENERS)
  } catch { /* torn-down / stub wc — best effort, warning is non-fatal */ }
}

/**
 * The right-panel Chrome DevTools front-end host (VIEW_ID.simulatorDevtools).
 * It inspects the SERVICE HOST (logic layer) — the hidden BrowserWindow where
 * the mini-app's page code runs. The service window can be swapped on respawn
 * (pre-warm pool), so the front-end is re-resolved fresh and re-pointed on
 * every render-side event.
 */
export interface DevtoolsHost {
  /** Rebuild the front-end host + subscribe to render events + point at the service host. */
  attach(): void
  /** Re-resolve + re-point the DevTools at the now-current service host (retries). */
  followServiceHost(appId?: string): void
  /** Unsubscribe render events, clear retries, and close the current source. */
  stopFollowing(): void
  /** Stop Elements forwarding (aggregate simulator detach, step order preserved). */
  stopElementsForwarding(): void
  /** Destroy the front-end host WCV (aggregate simulator detach). */
  destroyHostView(): void
}

export function createDevtoolsHost(
  ctx: ViewManagerContext,
  reconciler: PlacementReconciler,
  deps: {
    /** Reveal a project file in the embedded workbench editor. */
    openFileInWorkbench(relPath: string, line: number, column: number): boolean
  },
): DevtoolsHost {
  // The right-panel Chrome DevTools front-end HOST WebContentsView. Created by
  // rebuildDevtoolsHostView; positioned by the renderer's simulatorDevtools anchor.
  let simulatorView: WebContentsView | null = null
  let simulatorViewAdded = false
  // The webContents the right-panel Chrome DevTools front-end currently inspects.
  // We point it at the SERVICE HOST (logic layer) — the hidden BrowserWindow
  // where the mini-app's page code runs (`console.log`, `wx.request`,
  // Sources/Network(fetch) all live there). The UI/view layer (Elements/Styles/
  // WXML tree) is served separately by the native WXML panel + render-guest
  // highlight chain, so a single DevTools front-end is enough. The service window
  // can be swapped on respawn (pre-warm pool recycles it), so this is re-resolved
  // fresh via `ctx.bridge.getServiceWc()` and re-pointed on every render-side event.
  let nativeDevtoolsSourceWc: WebContents | null = null
  // `setDevToolsWebContents` requires its host argument to have never navigated
  // (Electron contract). The front-end host wc navigates the moment it is first
  // pointed at a service wc, so it is a one-shot resource: once used, re-pointing
  // to a different (pool-swapped) service wc must rebuild the host
  // (`rebuildDevtoolsHostView`) rather than target it again.
  let devtoolsHostUsed = false
  let unsubscribeNativeRenderEvents: (() => void) | null = null
  // Disposer for the Elements-forward feature (routes the front-end's Elements
  // CDP traffic at the active render guest). Installed in
  // `attach`, stopped on detach / host destroyed.
  let stopElementsForward: (() => void) | null = null
  // Disposer for the service-layer console capture (CDP `consoleAPICalled` on the
  // service host wc → console fan-out). Installed when the DevTools is pointed at
  // a service host, stopped when that source is closed / swapped.
  let stopServiceConsole: (() => void) | null = null
  let nativeDevtoolsRetryTimer: ReturnType<typeof setTimeout> | null = null
  let nativeDevtoolsRetryToken = 0
  // Front-end injects re-fire on EVERY re-point; while the host is loading each
  // raw executeJavaScript would queue one did-stop-loading waiter per call.
  // The deferred injector keeps one hook per (wc, kind) with latest-wins.
  const injectWhenReady = createLoadDeferredInjector()
  // The open-in-editor: click a console file link → workbench. The right-panel
  // console is the embedded Chromium DevTools front-end. Once a sourcemap maps a
  // console frame back to source, we redirect a source-link click to OUR
  // workbench editor instead of the DevTools Sources panel.
  const openInEditorWiredWcIds = new Set<number>()

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

  function injectOpenResourceHandler(serviceWc: WebContents, devtoolsWc: WebContents): void {
    // Inject the front-end glue that routes a project source-link click to our
    // Monaco editor instead of the DevTools Sources panel: a capture-phase click
    // interceptor re-emits an encoded sentinel via
    // `InspectorFrontendHost.openInNewTab` → Electron `devtools-open-url`. (The
    // legacy `setOpenResourceHandler` hook this used to rely on is gone in
    // current Chromium, so the script keeps it only as a fallback.)
    //
    // Destroy-race chokepoint: this runs from a deferred `dom-ready` callback
    // (see wireOpenInEditor), by which time the inspected service-host wc may
    // already be torn down (pool swap / project close / relaunch). Reading
    // `serviceWc.getURL()` on a destroyed wc throws "Object has been destroyed"
    // synchronously, which would escape the event listener. Guard both wc and
    // wrap the body so a teardown mid-call degrades silently (mirrors
    // customizeDevtoolsTabs).
    if (serviceWc.isDestroyed() || devtoolsWc.isDestroyed()) return
    try {
      const sourceContext = projectSourceContextFromServiceHostUrl(
        serviceWc.getURL(),
        ctx.workspace?.getProjectPath?.(),
      )
      if (!sourceContext) return
      devtoolsWc.executeJavaScript(buildDevtoolsProjectSourceLinksScript(sourceContext)).catch(() => {})
    } catch { /* wc torn down mid-call — degrade silently */ }
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
      injectWhenReady(devtoolsWc, 'customize-tabs', inject)
    } catch { /* wc surface incomplete / torn down; degrade silently */ }
  }

  function wireOpenInEditor(serviceWc: WebContents, devtoolsWc: WebContents): void {
    // Inject the front-end handler on every (re)attach — the DevTools front-end
    // wc is recreated per simulatorView, so a fresh host needs the handler set.
    if (!devtoolsWc.isDestroyed()) {
      injectWhenReady(devtoolsWc, 'open-in-editor', () => injectOpenResourceHandler(serviceWc, devtoolsWc))
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
      deps.openFileInWorkbench(target.path, target.line ?? 1, target.column ?? 1)
      ctx.notify.editorOpenFile(target)
    }
    serviceWc.on('devtools-open-url', onOpenUrl)
    // Consolidate teardown onto the connection layer,
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

    // The host wc is a one-shot `setDevToolsWebContents` target (Electron
    // forbids re-pointing at an already-navigated host): once used, a
    // service-wc swap must repoint onto a freshly rebuilt host instead.
    if (devtoolsHostUsed) {
      rebuildDevtoolsHostView()
    }
    if (!simulatorView || simulatorView.webContents.isDestroyed()) return true

    try {
      next.setDevToolsWebContents(simulatorView.webContents)
      // DevTools renders into the right-panel host view (simulatorView); with a
      // custom host the `mode` is overridden, and `activate:false` prevents it
      // stealing focus — this re-points whenever the service window is swapped,
      // so a focusing window would yank focus repeatedly (disrupting the user /
      // e2e).
      next.openDevTools({ mode: 'detach', activate: false })
      // The host is factually USED the moment it navigates (openDevTools) —
      // NOT when the whole wiring below succeeds. Flagging late lies to the
      // retry path: a mid-wiring throw (service wc torn down mid-point) left
      // the flag false, so the 50ms follow-retry re-pointed the SAME navigated
      // host over and over, re-running the front-end injects each attempt
      // until the host wc's pending executeJavaScript waiters tripped the
      // MaxListeners ceiling. Flag first: a failed attempt rebuilds fresh.
      devtoolsHostUsed = true
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
    } catch (err) {
      // Not silent: a throw here (service wc torn down mid-point is the common
      // one) makes the follow-retry loop spin — leave a trace so the spin has
      // a name in the log instead of hiding for weeks.
      console.warn('[devtools-host] point-at-service-wc failed; retry will rebuild:', err)
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

  // (Re)build the right-panel DevTools front-end host — a fresh, never-navigated
  // `simulatorView` WebContentsView. `setDevToolsWebContents` may only target a
  // host that has never navigated, so this is the sole path that produces a
  // usable host: called once on attach, and again by `pointNativeDevtoolsAtServiceWc`
  // whenever the current host has already been pointed at a service wc (a
  // service-host pool swap must repoint onto a fresh host, not reuse the
  // already-navigated one).
  function rebuildDevtoolsHostView(): void {
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
    // The boot-time burst of `executeJavaScript()` injects on this host wc (tab
    // customization / console default / Elements+Network forwarding below) each
    // queue a pending `did-stop-loading` waiter while the front-end is still
    // loading (see raiseExecuteJavaScriptListenerCeiling).
    raiseExecuteJavaScriptListenerCeiling(devtoolsWc)
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
      const thisForward = installElementsForward({
        devtoolsWc,
        bridge: ctx.bridge,
        connections: ctx.connections,
        // Shared session broker (see cdp-session/index.ts) — undefined falls
        // back to a private instance owned by this call.
        broker: ctx.cdpSessionBroker,
        // Body/post-data lookups for the virtual requestIds the network
        // forwarder injects — answered from its prefetch cache when the
        // front-end's Response tab round-trips Network.getResponseBody.
        network: ctx.networkForward?.bodies,
      })
      stopElementsForward = thisForward
      devtoolsWc.once('destroyed', () => {
        try { thisForward() } catch { /* already stopped */ }
        if (stopElementsForward === thisForward) stopElementsForward = null
      })
    }
    injectWhenReady(devtoolsWc, 'console-default', () => {
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
    // The view now exists: re-run the reconciler so a placement published before
    // this attach (project-open ordering) attaches it once the gate re-opens.
    reconciler.reconcileNow()

    // A freshly built host has never navigated — it may be targeted by
    // `setDevToolsWebContents` again.
    devtoolsHostUsed = false
  }

  function attachNativeSimulatorDevtoolsHost(): void {
    stopFollowingNativeServiceHost()
    rebuildDevtoolsHostView()

    if (ctx.bridge?.isNativeHost()) {
      unsubscribeNativeRenderEvents = ctx.bridge.onRenderEvent(onNativeRenderEvent)
      followNativeDevtoolsServiceHost()
    }
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
    // The instance is being replaced/destroyed — forget its reconciled mount
    // state so the next rebuilt host is treated as a fresh attach. Without this,
    // the level-triggered reconciler still records `simulatorDevtools` as
    // `attached` (the manual removeChildView above bypasses it), so it never
    // emits the `attach` op for the rebuilt view and the new host is never
    // addChildView'd — embedded but invisible. Mirrors the hostToolbar /
    // simulator instance-replacement handling (ensureHostToolbarView /
    // tearDownNativeSimulatorView).
    reconciler.forgetActual(VIEW_ID.simulatorDevtools)
  }

  reconciler.registerView(VIEW_ID.simulatorDevtools, {
    getView: () => simulatorView,
    setAdded: (added) => { simulatorViewAdded = added },
    gateHidden: () => !simulatorView,
  })

  return {
    attach: attachNativeSimulatorDevtoolsHost,
    followServiceHost: followNativeDevtoolsServiceHost,
    stopFollowing: stopFollowingNativeServiceHost,
    stopElementsForwarding: () => {
      // Stop Elements forwarding (detaches only the debugger sessions IT attached;
      // safe-area's sessions are untouched). Idempotent — the host 'destroyed'
      // handler may have already run.
      try { stopElementsForward?.() } catch { /* already stopped */ }
      stopElementsForward = null
    },
    destroyHostView: () => {
      destroyChildView(ctx.windows.mainWindow, simulatorView)
      simulatorView = null
      simulatorViewAdded = false
    },
  }
}
