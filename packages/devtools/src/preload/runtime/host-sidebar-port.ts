/**
 * Preload side of the host-sidebar gated narrow channel.
 *
 * ── PUBLIC SURFACE EVOLUTION RULE ───────────────────────────────────────────
 * `window.diminaHostSidebar` is a published page-facing API, typed by the
 * exported `DiminaHostSidebarPageBridge` (src/main/runtime/miniapp-runtime.ts)
 * — arbitrary host sidebar pages compile against it. Members may only be
 * ADDED, never changed: any semantic change to an existing member (signature,
 * return shape, queueing/throw behavior) ships under a NEW name instead.
 * Exception: security fixes / compliance corrections may change existing
 * member semantics, and MUST be called out in the release's version notes.
 * Keep the exported bridge type in lockstep with what is exposed here.
 *
 * Receives the per-load MessagePort main transfers on `did-finish-load`
 * (`ViewChannel.HostSidebarPort`, `event.ports[0]`) and bridges it to the page
 * as `window.diminaHostSidebar` — EXACTLY `{ send, onMessage }`, functions
 * only. The raw MessagePort never crosses into the main world: the page only
 * ever talks through these two functions, so the `{ channel, payload }`
 * envelope stays the single waist (same posture as the main side's
 * host-sidebar-port-channel.ts).
 *
 * Ordering reality this module absorbs — identical to the toolbar's port
 * bridge (see host-toolbar-port.ts for the full rationale): pre-handshake
 * sends queue and bounded-drop, handlers register before the port exists and
 * re-attach across same-load re-handshakes, inbound dispatch drops malformed
 * envelopes without throwing.
 *
 * Shared implementation: see `host-slot-port-bridge.ts` (the toolbar/sidebar/
 * dialog port bridges are otherwise identical; only the constants below
 * differ).
 */

import { ViewChannel } from '../../shared/ipc-channels-overlays.js'
import { createHostSlotPortBridge } from './host-slot-port-bridge.js'

/**
 * Cap on pre-handshake queued sends. Same rationale and value as
 * `HOST_TOOLBAR_PENDING_LIMIT` — overflow drops the NEWEST envelope, one
 * console.warn per load.
 */
export const HOST_SIDEBAR_PENDING_LIMIT = 128

/**
 * Subscribe the handshake channel and expose the page bridge. Call ONLY from
 * a passing sidebar-runtime guard (`activateHostSidebarRuntime`) — a failing
 * guard must leave zero footprint (no bridge key, no IPC listener).
 */
export function installHostSidebarPortBridge(): void {
  createHostSlotPortBridge({
    bridgeKey: 'diminaHostSidebar',
    channel: ViewChannel.HostSidebarPort,
    pendingLimit: HOST_SIDEBAR_PENDING_LIMIT,
    label: 'host-sidebar',
  })
}
