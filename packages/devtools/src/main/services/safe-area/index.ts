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
 * The DeviceShell already RESERVES the chrome edges (in-flow nav-bar at top,
 * tab-bar + home-indicator at bottom), so the guest does not border those unsafe
 * zones for a default page. We therefore surface only the TOP inset — which a
 * full-bleed / custom-nav page needs to clear the notch — and keep BOTTOM at 0
 * so a page's own `env(safe-area-inset-bottom)` padding does not double-count
 * against the home-indicator strip the shell already draws. (Per the design doc
 * + codex review: docs/ios-safe-area-and-notch.md.)
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

function guestInsets(device: NativeDeviceInfo | null): CdpSafeAreaInsets {
  const top = device?.safeAreaInsets.top ?? 0
  return { top, topMax: top, right: 0, rightMax: 0, bottom: 0, bottomMax: 0, left: 0, leftMax: 0 }
}

export interface SafeAreaController {
  /** Attach the debugger to a freshly-attached render-host guest and push the
   *  current device's insets. No-op (warn) if the guest is already claimed by an
   *  external CDP client — env then stays 0 rather than throwing. */
  applyToGuest(guestWc: WebContents, device: NativeDeviceInfo | null): void
  /** Re-push insets to every still-attached guest after a device change. */
  reapplyAll(device: NativeDeviceInfo | null): void
  /** Detach from all guests (teardown). */
  dispose(): void
}

export function createSafeAreaController(options: { connections?: ConnectionRegistry } = {}): SafeAreaController {
  // Guests we successfully attached `wc.debugger` to (so we don't re-attach,
  // which throws). Pruned on guest destroy.
  const attached = new Set<WebContents>()

  function override(wc: WebContents, device: NativeDeviceInfo | null): void {
    if (wc.isDestroyed()) return
    void wc.debugger
      .sendCommand('Emulation.setSafeAreaInsetsOverride', { insets: guestInsets(device) })
      .catch((err) => {
        console.warn('[safe-area] setSafeAreaInsetsOverride failed:', err instanceof Error ? err.message : err)
      })
  }

  return {
    applyToGuest: (wc, device) => {
      if (!wc || wc.isDestroyed() || attached.has(wc)) {
        if (wc && !wc.isDestroyed() && attached.has(wc)) override(wc, device)
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
      attached.add(wc)
      if (options.connections) {
        options.connections.acquire(wc).own(() => attached.delete(wc))
      } else {
        wc.once('destroyed', () => attached.delete(wc))
      }
      override(wc, device)
    },
    reapplyAll: (device) => {
      for (const wc of attached) override(wc, device)
    },
    dispose: () => {
      for (const wc of attached) {
        try {
          if (!wc.isDestroyed()) wc.debugger.detach()
        } catch { /* already detached / destroyed */ }
      }
      attached.clear()
    },
  }
}
