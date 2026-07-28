import type { WebContents } from 'electron'
import type { ConnectionRegistry } from '@dimina-kit/electron-deck/main'
import type { NativeDeviceInfo } from '../../../shared/ipc-channels.js'
import { createCdpSessionBroker, type CdpSessionBroker, type CdpSessionLease } from '../cdp-session/index.js'

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

function guestInsets(device: NativeDeviceInfo | null, isTabPage: boolean): CdpSafeAreaInsets {
  const top = device?.safeAreaInsets.top ?? 0
  // A tab page's content sits above the shell-drawn tabBar (which fills the
  // bottom safe area), so it never borders the bottom unsafe zone. A non-tab
  // page is full-bleed to the device bottom, so surface the real inset for its
  // own `env(safe-area-inset-bottom)` opt-in.
  const bottom = isTabPage ? 0 : (device?.safeAreaInsets.bottom ?? 0)
  return { top, topMax: top, right: 0, rightMax: 0, bottom, bottomMax: bottom, left: 0, leftMax: 0 }
}

export interface SafeAreaController {
  /** Attach the debugger to a freshly-attached render-host guest and push the
   *  current device's insets. `isTabPage` selects the bottom-inset policy (0 for
   *  tab pages, the real inset for full-bleed non-tab pages). No-op (warn) if the
   *  guest is already claimed by an external CDP client — env then stays 0. */
  applyToGuest(guestWc: WebContents, device: NativeDeviceInfo | null, isTabPage: boolean): void
  /** Re-push insets to every still-attached guest after a device change (each
   *  guest keeps the page type it attached with). */
  reapplyAll(device: NativeDeviceInfo | null): void
  /** Release this controller's session leases (teardown). Does not itself
   *  detach the shared debugger session — see cdp-session/index.ts. */
  dispose(): void
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

  // Each guest's page type, fixed for its life — tracked SEPARATELY from the
  // lease so a lost session (external detach) doesn't lose the policy: a
  // later `override`/`reapplyAll` can reacquire and keep applying the same
  // isTabPage this guest attached with.
  const pageType = new Map<WebContents, boolean>()
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

  function override(wc: WebContents, device: NativeDeviceInfo | null, isTabPage: boolean): void {
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
      .send('Emulation.setSafeAreaInsetsOverride', { insets: guestInsets(device, isTabPage) })
      .catch((err) => {
        console.warn('[safe-area] setSafeAreaInsetsOverride failed:', err instanceof Error ? err.message : err)
      })
  }

  return {
    applyToGuest: (wc, device, isTabPage) => {
      if (!wc || wc.isDestroyed()) return
      const isFirstTime = !pageType.has(wc)
      pageType.set(wc, isTabPage)
      if (isFirstTime) {
        const forget = (): void => { pageType.delete(wc); leases.delete(wc) }
        if (options.connections) {
          options.connections.acquire(wc).own(forget)
        } else {
          wc.once('destroyed', forget)
        }
      }
      override(wc, device, isTabPage)
    },
    reapplyAll: (device) => {
      for (const [wc, isTabPage] of pageType) override(wc, device, isTabPage)
    },
    dispose: () => {
      // Release our leases only — the shared session's actual detach is the
      // broker's own top-level dispose() to decide (another consumer may
      // still be using it).
      for (const lease of leases.values()) lease.dispose()
      leases.clear()
      pageType.clear()
      if (ownsBroker) broker.dispose()
    },
  }
}
