import type { WebContents } from 'electron'
import type { ConnectionRegistry } from '@dimina-kit/electron-deck/main'
import type { NativeDeviceInfo } from '../../../shared/ipc-channels.js'

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
  /** Detach from all guests (teardown). */
  dispose(): void
}

export function createSafeAreaController(options: { connections?: ConnectionRegistry } = {}): SafeAreaController {
  // Guests we successfully attached `wc.debugger` to (value = the page's
  // `isTabPage`, fixed for the guest's life — it's one page). So we don't
  // re-attach (throws), and a device-change reapply reuses the same policy.
  const attached = new Map<WebContents, boolean>()

  function override(wc: WebContents, device: NativeDeviceInfo | null, isTabPage: boolean): void {
    if (wc.isDestroyed()) return
    void wc.debugger
      .sendCommand('Emulation.setSafeAreaInsetsOverride', { insets: guestInsets(device, isTabPage) })
      .catch((err) => {
        console.warn('[safe-area] setSafeAreaInsetsOverride failed:', err instanceof Error ? err.message : err)
      })
  }

  return {
    applyToGuest: (wc, device, isTabPage) => {
      if (!wc || wc.isDestroyed() || attached.has(wc)) {
        if (wc && !wc.isDestroyed() && attached.has(wc)) override(wc, device, isTabPage)
        return
      }
      try {
        wc.debugger.attach('1.3')
      } catch (err) {
        // Already attached by an external --remote-debugging-port client (or
        // DevTools). Degrade: leave env at 0 rather than fail the page.
        console.warn('[safe-area] debugger.attach failed; env(safe-area-inset-*) stays 0:', err instanceof Error ? err.message : err)
        return
      }
      attached.set(wc, isTabPage)
      if (options.connections) {
        options.connections.acquire(wc).own(() => attached.delete(wc))
      } else {
        wc.once('destroyed', () => attached.delete(wc))
      }
      override(wc, device, isTabPage)
    },
    reapplyAll: (device) => {
      for (const [wc, isTabPage] of attached) override(wc, device, isTabPage)
    },
    dispose: () => {
      for (const wc of attached.keys()) {
        try {
          if (!wc.isDestroyed()) wc.debugger.detach()
        } catch { /* already detached / destroyed */ }
      }
      attached.clear()
    },
  }
}
