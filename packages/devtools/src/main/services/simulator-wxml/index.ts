/**
 * Native-host WXML panel service.
 *
 * Mirrors simulator-storage's main→renderer contract so the renderer WXML panel
 * needs no per-mode branching of its own data shape:
 *   - PULL: answers `SimulatorWxmlChannel.GetSnapshot` by reading the active
 *     render-host guest's WXML tree via the injected RenderInspector.
 *   - PUSH: on bridge render-side activity (domReady / active-page change),
 *     re-reads the tree and pushes `SimulatorWxmlChannel.Event` to the renderer
 *     host — keeping the panel reactive without polling.
 *
 * Only meaningful under native-host (the default dimina-fe path sources WXML
 * from the simulator guest's miniappSnapshot transport); app.ts gates the call
 * on `ctx.bridge.isNativeHost()`.
 */
import type { WebContents } from 'electron'
import { SimulatorWxmlChannel } from '../../../shared/ipc-channels.js'
import type { WxmlNode } from '../../../preload/shared/sid-registry.js'
import type { BridgeRouterHandle } from '../../ipc/bridge-router.js'
import { DisposableRegistry, type Disposable } from '@dimina-kit/electron-deck/main'
import { IpcRegistry, type SenderPolicy } from '../../utils/ipc-registry.js'
import type { RenderInspector } from '../render-inspect/index.js'

export interface SimulatorWxmlOptions {
  bridge: BridgeRouterHandle
  inspector: RenderInspector
  getActiveAppId: () => string | null
  /** Sender gate applied to the WXML IPC handler; omitted in unit tests. */
  senderPolicy?: SenderPolicy
}

export function setupSimulatorWxml(host: WebContents, options: SimulatorWxmlOptions): Disposable {
  const { bridge, inspector, getActiveAppId } = options
  const registry = new DisposableRegistry()

  // Whether the WXML panel is currently visible (renderer drives this via
  // SetActive). Live tree pushes + the render-guest DOM observer only run while
  // active, so an unseen panel never triggers a full Vue-tree walk.
  let active = false
  // latest-wins: only the newest pull's result is pushed (a slow walk that
  // resolves after a newer one must not clobber the fresher tree).
  let seq = 0
  // in-flight coalescing: at most one pull runs at a time; a request that lands
  // mid-pull sets `again` so exactly one follow-up pull runs after it settles.
  let pulling = false
  let again = false
  // The render guest currently being observed, so we can stop it on page change
  // / deactivation (single owner).
  let observedWc: WebContents | null = null

  /** The visible page's render WebContents of the active app, or null. */
  function activeWc(): WebContents | null {
    return bridge.getActiveRenderWc(getActiveAppId() ?? undefined)
  }

  /** Read the WXML tree of a render guest, or null when there is none. */
  async function pull(wc: WebContents | null): Promise<WxmlNode | null> {
    if (!wc) return null
    return inspector.getWxml(wc)
  }

  /**
   * Pull the active tree and push it, gated by `active` and reconciled by
   * latest-wins + in-flight coalescing so a burst of render events (setData)
   * collapses to a single fresh push instead of a pile of overlapping walks.
   */
  function schedulePull(): void {
    if (!active) return
    const mySeq = ++seq
    if (pulling) { again = true; return }
    pulling = true
    void pull(activeWc())
      .then((tree) => {
        // Re-check `active` at send time: a pull started while visible must NOT
        // push after the panel was hidden / disposed (deactivate bumps `seq`, so
        // `mySeq === seq` also guards, but the explicit `active` check is the
        // clear invariant).
        if (mySeq === seq && active && !host.isDestroyed()) {
          host.send(SimulatorWxmlChannel.Event, tree)
        }
      })
      .finally(() => {
        pulling = false
        if (again) { again = false; schedulePull() }
      })
  }

  function startObserving(wc: WebContents | null): void {
    if (!wc) return
    observedWc = wc
    // The guest IIFE defers observe() until document.body exists, so a wc whose
    // DOM isn't up yet still starts observing once it loads — no retry needed here.
    void inspector.setWxmlObserving(wc, true)
  }

  function stopObserving(): void {
    const wc = observedWc
    observedWc = null
    if (wc) void inspector.setWxmlObserving(wc, false)
  }

  /**
   * Point the DOM observer at the CURRENT active render guest. Called on every
   * render event while active, so the observer installs even when SetActive fired
   * before the guest existed (the guest appears on `domReady`) and follows the
   * active page across navigation (`activePage`).
   */
  function reconcileObserving(): void {
    if (!active) return
    const wc = activeWc()
    if (wc !== observedWc) { stopObserving(); startObserving(wc) }
  }

  /** Invalidate any in-flight pull + queued re-pull so nothing pushes post-hide. */
  function cancelPending(): void {
    seq++
    again = false
  }

  const ipc = new IpcRegistry(options.senderPolicy)
  ipc.handle(SimulatorWxmlChannel.GetSnapshot, () => pull(activeWc()))
  ipc.handle(SimulatorWxmlChannel.SetActive, (_event, on: boolean) => {
    if (on) {
      active = true
      reconcileObserving()
      schedulePull() // seed the now-visible panel
    } else {
      active = false
      cancelPending()
      stopObserving()
    }
  })
  registry.add(ipc)

  // Re-read + push on render-side activity: a page's DOM mounted (`domReady`),
  // the visible page changed (`activePage`), or the active page's DOM mutated in
  // place (`domMutated`, from the render-guest observer). Gated by `active` and
  // scoped to the ACTIVE app so a background app's / stale bridge's event never
  // drives a spurious full walk of the visible page.
  const unsubscribe = bridge.onRenderEvent((event) => {
    if (!active) return
    const appId = getActiveAppId()
    if (appId && event.appId !== appId) return
    // domReady: the guest may have just appeared → (re)install the observer.
    // activePage: the active guest changed → move the observer.
    // domMutated: same guest → reconcile is a no-op, then pull.
    reconcileObserving()
    schedulePull()
  })
  registry.add(unsubscribe)
  // Stop observing + invalidate in-flight pulls on teardown (best-effort).
  registry.add(() => { active = false; cancelPending(); stopObserving() })

  return registry
}
