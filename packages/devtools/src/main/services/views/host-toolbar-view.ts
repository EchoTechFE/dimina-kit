import type { WebContents } from 'electron'
import { WebContentsView } from 'electron'
import { handleWindowOpenExternal } from '../../windows/navigation-hardening.js'
import { HOST_TOOLBAR_RUNTIME_MARKER } from '../../../shared/constants.js'
import { VIEW_ID, VIEW_LAYER } from '../../../shared/view-ids.js'
import {
  acquireHostToolbarSessionRuntime,
  releaseHostToolbarSessionRuntime,
} from './host-toolbar-session-runtime.js'
import { createHostToolbarPortChannel } from './host-toolbar-port-channel.js'
import { destroyChildView } from './destroy-child-view.js'
import type { PlacementReconciler } from './placement-reconciler.js'
import type {
  HostToolbarControl,
  HostToolbarHeightMode,
  ViewManagerContext,
} from './view-manager.js'

/**
 * A strip above the devtools header that the downstream host loads its own
 * content into and fully controls. Bounds come from a renderer DOM anchor
 * (forward anchor, like the simulator DevTools overlay); its height is dynamic
 * via a reverse size-advertiser the toolbar's own renderer drives.
 */
export interface HostToolbarView {
  readonly control: HostToolbarControl
  setHostToolbarHeight(extent: number): void
  getHostToolbarHeight(): number
  getHostToolbarWebContentsId(): number | null
  /** Teardown for `disposeAll`: sweep the port, destroy the view, release the runtime ref. */
  dispose(): void
}

export function createHostToolbarView(
  ctx: ViewManagerContext,
  reconciler: PlacementReconciler,
  deps: {
    /** Re-apply the settings/popover overlays whose height depends on the toolbar strip. */
    reapplyPresentOverlays(): void
  },
): HostToolbarView {
  let hostToolbarView: WebContentsView | null = null
  let hostToolbarPreloadOverride: string | null = null
  let hostToolbarViewAdded = false
  // Whether THIS manager holds a reference on the shared defaultSession
  // registration of the toolbar-runtime preload (see
  // host-toolbar-session-runtime.ts). Acquired on first toolbar need,
  // released exactly once in dispose — a manager that never used the
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
    // The instance is being replaced — forget its reconciled mount state so the
    // rebuilt view is treated as a fresh attach (not skipped as already-attached).
    reconciler.forgetActual(VIEW_ID.hostToolbar)
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

  // Single funnel for the height notify: retain-then-push, so the retained
  // value is exactly the last value the renderer was told. Every height
  // notify site MUST go through here — the renderer pulls the retained value
  // on project-view mount to replay a push it missed (the toolbar's
  // size-advertiser deduplicates and never re-reports).
  function notifyHostToolbarHeight(height: number): void {
    hostToolbarLastHeight = height
    ctx.notify.hostToolbarHeightChanged(height)
    deps.reapplyPresentOverlays()
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
    reconciler.setBaseDesired(VIEW_ID.hostToolbar, {
      viewId: VIEW_ID.hostToolbar,
      placement: { visible: false },
      layer: VIEW_LAYER.hostToolbar,
    })
    reconciler.reconcileNow()
    // Collapse the renderer placeholder to 0 too. Otherwise its anchor keeps a
    // non-zero reserved height and re-publishes bounds on the next window
    // resize, silently re-adding the view we just hid (unstable hide). Zeroing
    // the height flips the anchor to `present:false` so it stops re-publishing.
    // Through the funnel so the retained value follows to 0 — a renderer
    // mounting after the hide must replay 0, not the stale pre-hide height.
    notifyHostToolbarHeight(0)
  }

  const control: HostToolbarControl = {
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
    onMessage(channel, handler) {
      return hostToolbarPort.onMessage(channel, handler)
    },
    onReady(handler) {
      return hostToolbarPort.onReady(handler)
    },
    send(channel, payload): boolean {
      return hostToolbarPort.send(channel, payload)
    },
  }

  reconciler.registerView(VIEW_ID.hostToolbar, {
    getView: () => hostToolbarView,
    ensureView: () => ensureHostToolbarView(),
    setAdded: (added) => { hostToolbarViewAdded = added },
    ensureLazy: (desired) => {
      if (desired?.placement.visible && !liveHostToolbarWebContents()) ensureHostToolbarView()
    },
  })

  function dispose(): void {
    // Narrow channel first: close the live MessagePort + sweep the onMessage
    // registry, so a send() racing teardown reports false instead of posting
    // into a wc that is about to be closed.
    hostToolbarPort.dispose()
    // Host-controllable toolbar view: removed from the contentView + its
    // WebContents closed (the host's loaded content is torn down on app exit).
    destroyChildView(ctx.windows.mainWindow, hostToolbarView)
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
  }

  return {
    control,
    setHostToolbarHeight,
    getHostToolbarHeight: () => hostToolbarLastHeight,
    getHostToolbarWebContentsId: () => liveHostToolbarWebContents()?.id ?? null,
    dispose,
  }
}
