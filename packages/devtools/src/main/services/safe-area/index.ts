import type { WebContents } from 'electron'
import type { ConnectionRegistry } from '@dimina-kit/electron-deck/main'
import type { NativeDeviceInfo } from '../../../shared/ipc-channels.js'
import { createCdpSessionBroker, type CdpSessionBroker, type CdpSessionLease } from '../cdp-session/index.js'
import { orientedSafeAreaInsets, type Orientation } from '@dimina-kit/electron-runtime/shared/page-orientation'

/**
 * CSS `env(safe-area-inset-*)` simulation for render-host `<webview>` guests.
 *
 * Desktop Chromium has no physical notch, so a mini-program page laid out
 * edge-to-edge sees `env(safe-area-inset-*) = 0`. We override it per device via
 * the CDP `Emulation.setSafeAreaInsetsOverride` command (verified on Electron 41
 * / Chromium 146 — it drives `env(safe-area-inset-*)` directly and works on a
 * `<webview>` guest). Driven from `did-attach-webview` so the value resolves
 * before the page paints.
 *
 * The DeviceShell reserves the TOP chrome (status/nav) for every page, so we
 * always surface the TOP inset — a full-bleed / custom-nav page needs it to
 * clear the notch. The BOTTOM inset is per page TYPE (WeChat parity):
 *   - tab page  → the shell draws the tabBar and extends its background through
 *     the home-indicator safe area; the guest (page content sits ABOVE the
 *     tabBar) does not border the bottom unsafe zone → BOTTOM 0.
 *   - non-tab page → the guest is full-bleed to the device bottom, so surface
 *     the real bottom inset and let the page opt in via its own
 *     `env(safe-area-inset-bottom)`; the shell reserves nothing there.
 * The attaching guest's page type is read from its render-host URL (`isTab`)
 * in view-manager's `did-attach-webview`. (Design doc: docs/ios-safe-area-and-notch.md.)
 *
 * Which orientation the insets are resolved AGAINST is per page, not per device: `pageOrientation` lets a page run landscape on an upright phone (and the reverse), and `wx.getSystemInfoSync().safeArea` already answers for the page.
 * Both sides therefore go through the same `orientedSafeAreaInsets`, fed by the same authority — DeviceShell's `PAGE_RESIZE`, which reaches here as the runtime's `'session-orientation'` event and is routed by `bridgeId`.
 * Spraying one orientation over every guest would be wrong: a tab substack keeps hidden pages mounted, and those keep their own.
 */

/** The 8-field CDP `SafeAreaInsets` shape (base + *Max). Omitting `*Max` leaves
 *  `env(safe-area-max-inset-*)` at 0, so mirror base→max. */
interface CdpSafeAreaInsets {
  top: number
  topMax: number
  right: number
  rightMax: number
  bottom: number
  bottomMax: number
  left: number
  leftMax: number
}

/** What main knows about the page a render guest is showing. */
export interface GuestPage {
  /**
   * The `bridgeId` query param of the guest's render-host URL.
   * Keys the per-page orientation this guest's insets are resolved against; null when the URL could not be parsed, which falls the guest back to the device.
   */
  bridgeId: string | null
  /** Selects the bottom-inset policy (see the module comment). */
  isTabPage: boolean
}

function guestInsets(
  device: NativeDeviceInfo | null,
  isTabPage: boolean,
  orientation: Orientation,
): CdpSafeAreaInsets {
  // Insets follow the orientation on screen: in landscape the notch moves off the top edge and onto both sides, which is what WeChat's own base library resolves `env(safe-area-inset-*)` to for a landscape notched phone.
  const insets = device
    ? orientedSafeAreaInsets(
        { statusBarHeight: device.statusBarHeight, hasNotch: device.notchType !== 'none', safeAreaInsets: device.safeAreaInsets },
        orientation,
      )
    : { top: 0, right: 0, bottom: 0, left: 0 }
  const top = insets.top
  // A tab page's content sits above the shell-drawn tabBar (which fills the
  // bottom safe area), so it never borders the bottom unsafe zone. A non-tab
  // page is full-bleed to the device bottom, so surface the real inset for its
  // own `env(safe-area-inset-bottom)` opt-in.
  const bottom = isTabPage ? 0 : insets.bottom
  return {
    top,
    topMax: top,
    right: insets.right,
    rightMax: insets.right,
    bottom,
    bottomMax: bottom,
    left: insets.left,
    leftMax: insets.left,
  }
}

export interface SafeAreaController {
  /** Attach the debugger to a freshly-attached render-host guest and push the
   * insets for the orientation its page shows (already reported for that `bridgeId`, else the device's).
   * No-op (warn) if the guest is already claimed by an external CDP client — env then stays 0. */
  applyToGuest(guestWc: WebContents, device: NativeDeviceInfo | null, page: GuestPage): void
  /** Record the orientation one page shows and re-push that page's guest alone.
   * Accepted before the guest attaches — routing publishes a page's resize before its `<webview>` mounts — so the first push is already correct. */
  recordPageOrientation(bridgeId: string, orientation: Orientation, device: NativeDeviceInfo | null): void
  /** Drop a closed page's recorded orientation. The page's own lifetime is the
   * only thing that ends the entry: a page keeps its bridgeId across a render guest swap, and an entry can exist before any guest attaches at all. */
  forgetPageOrientation(bridgeId: string): void
  /** Re-push insets to every still-attached guest after a device change. Each
   * guest keeps the page type it attached with and the orientation its own page last reported; only the inset magnitudes follow the new device. */
  reapplyAll(device: NativeDeviceInfo | null): void
  /** Release this controller's session leases (teardown). Does not itself
   *  detach the shared debugger session — see cdp-session/index.ts. */
  dispose(): void
  /** Point-in-time size of every ledger this controller owns. Leak coverage
   * asserts EXACT equality around a churn cycle: each of these grows per page or per guest, so only the owner's own counts can show one of them being retained after the thing it belongs to is gone. */
  census(): SafeAreaCensus
}

export interface SafeAreaCensus {
  /** Attached render guests still tracked. */
  guests: number
  /** CDP leases currently held. */
  leases: number
  /** Pages whose reported orientation is still recorded. */
  pageOrientations: number
}

export function createSafeAreaController(options: { connections?: ConnectionRegistry, broker?: CdpSessionBroker } = {}): SafeAreaController {
  // Own (and dispose on this controller's own dispose()) a private broker
  // only when the caller didn't supply a shared one.
  const ownsBroker = !options.broker
  // The shared CDP session broker (see cdp-session/index.ts) — reused across
  // safe-area/elements-forward/render-inspect/network-forward when the caller
  // passes one; falls back to a private instance so this module stays
  // independently testable/usable.
  const broker = options.broker ?? createCdpSessionBroker({ connections: options.connections })

  // Each guest's page identity, fixed for its life — tracked SEPARATELY from the lease so a lost session (external detach) doesn't lose it: a later `override`/`reapplyAll` can reacquire and keep applying the same policy this guest attached with.
  const guests = new Map<WebContents, GuestPage>()
  // The orientation each page currently shows, as last reported by DeviceShell.
  // Keyed by bridgeId rather than by guest so an orientation that arrives before the page's `<webview>` attaches is not lost.
  // An entry lives for as long as its PAGE does: `forgetPageOrientation` (driven by page close / session teardown) ends it, and dispose() clears the lot.
  // Guest destruction must not — the same page can be handed a replacement guest.
  const pageOrientations = new Map<string, Orientation>()
  // Current lease per guest, if any. Cleared (not just left stale) on
  // `lease.onDetach` — an external detach or a real Chrome DevTools window
  // stealing the session — so the next `override` reacquires instead of
  // sending through a dead lease forever.
  const leases = new Map<WebContents, CdpSessionLease>()

  /** Get-or-reacquire this guest's lease. Null when the session is unavailable. */
  function ensureLease(wc: WebContents): CdpSessionLease | null {
    const existing = leases.get(wc)
    if (existing) return existing
    const lease = broker.acquire(wc)
    if (!lease) return null
    leases.set(wc, lease)
    lease.onDetach(() => { leases.delete(wc) })
    return lease
  }

  /** The orientation this guest's own page shows; the device's until it reports. */
  function orientationFor(page: GuestPage, device: NativeDeviceInfo | null): Orientation {
    const reported = page.bridgeId === null ? undefined : pageOrientations.get(page.bridgeId)
    return reported ?? device?.deviceOrientation ?? 'portrait'
  }

  function override(wc: WebContents, device: NativeDeviceInfo | null, page: GuestPage): void {
    if (wc.isDestroyed()) return
    const lease = ensureLease(wc)
    if (!lease) {
      // Exclusively held elsewhere (e.g. a real Chrome DevTools window via
      // --remote-debugging-port). Degrade: leave env at 0 rather than fail
      // the page.
      console.warn('[safe-area] debugger session unavailable; env(safe-area-inset-*) stays 0')
      return
    }
    void lease
      .send('Emulation.setSafeAreaInsetsOverride', {
        insets: guestInsets(device, page.isTabPage, orientationFor(page, device)),
      })
      .catch((err: unknown) => {
        console.warn('[safe-area] setSafeAreaInsetsOverride failed:', err instanceof Error ? err.message : err)
      })
  }

  return {
    applyToGuest: (wc, device, page) => {
      if (!wc || wc.isDestroyed()) return
      const isFirstTime = !guests.has(wc)
      guests.set(wc, page)
      if (isFirstTime) {
        // Releases only what belongs to THIS WebContents.
        // The page's recorded orientation is deliberately left alone: the runtime can hand the same bridgeId a replacement guest, and dropping the entry here would make the surviving page fall back to the device orientation while its JS still reports its own. `forgetPageOrientation` ends that entry.
        const release = (): void => {
          guests.delete(wc)
          leases.delete(wc)
        }
        if (options.connections) {
          options.connections.acquire(wc).own(release)
        } else {
          wc.once('destroyed', release)
        }
      }
      override(wc, device, page)
    },
    recordPageOrientation: (bridgeId, orientation, device) => {
      pageOrientations.set(bridgeId, orientation)
      for (const [wc, page] of guests) {
        if (page.bridgeId === bridgeId) override(wc, device, page)
      }
    },
    forgetPageOrientation: (bridgeId) => {
      pageOrientations.delete(bridgeId)
    },
    reapplyAll: (device) => {
      for (const [wc, page] of guests) override(wc, device, page)
    },
    dispose: () => {
      // Release our leases only — the shared session's actual detach is the
      // broker's own top-level dispose() to decide (another consumer may
      // still be using it).
      for (const lease of leases.values()) lease.dispose()
      leases.clear()
      guests.clear()
      pageOrientations.clear()
      if (ownsBroker) broker.dispose()
    },
    census: () => ({
      guests: guests.size,
      leases: leases.size,
      pageOrientations: pageOrientations.size,
    }),
  }
}
