/**
 * Preload side of the host-toolbar gated narrow channel.
 *
 * ── PUBLIC SURFACE EVOLUTION RULE ───────────────────────────────────────────
 * `window.diminaHostToolbar` is a published page-facing API, typed by the
 * exported `DiminaHostToolbarPageBridge` (src/main/runtime/miniapp-runtime.ts)
 * — arbitrary host toolbar pages compile against it. Members may only be
 * ADDED, never changed: any semantic change to an existing member (signature,
 * return shape, queueing/throw behavior) ships under a NEW name instead.
 * Exception: security fixes / compliance corrections may change existing
 * member semantics, and MUST be called out in the release's version notes.
 * Keep the exported bridge type in lockstep with what is exposed here.
 *
 * Receives the per-load MessagePort main transfers on `did-finish-load`
 * (`ViewChannel.HostToolbarPort`, `event.ports[0]`) and bridges it to the page
 * as `window.diminaHostToolbar` — EXACTLY `{ send, onMessage }`, functions
 * only. The raw MessagePort never crosses into the main world: the page only
 * ever talks through these two functions, so the `{ channel, payload }`
 * envelope stays the single waist (same posture as the main side's
 * host-toolbar-port-channel.ts).
 *
 * Ordering reality this module absorbs:
 *  - The page script runs BEFORE the handshake can complete (the port is
 *    posted on did-finish-load). Page `send()`s issued before the port
 *    arrives go into a PENDING QUEUE and flush in order on handshake —
 *    without it the first message of every load is silently dropped. The
 *    queue is BOUNDED at `HOST_TOOLBAR_PENDING_LIMIT` (128): the toolbar page
 *    is arbitrary host content, and a page whose handshake never arrives must
 *    not grow main-world-driven memory without limit. Overflow drops the
 *    NEWEST send (boot sequences front-load their important messages; the
 *    first-comers survive), warns ONCE per load, and never throws into page
 *    code.
 *  - Page handlers likewise register before the port exists; the registry is
 *    module-level (per-load — the preload re-runs on every navigation) and is
 *    re-attached to each newly delivered port, so a same-load re-handshake
 *    keeps existing handlers alive. The LATER port wins for sends.
 *  - Inbound dispatch uses `addEventListener('message')` + `start()`
 *    (without `start()` a DOM MessagePort never delivers) and DROPS malformed
 *    envelopes without throwing.
 *
 * Shared implementation: see `host-slot-port-bridge.ts` (the toolbar/sidebar/
 * dialog port bridges are otherwise identical; only the constants below
 * differ).
 */

import { ViewChannel } from '../../shared/ipc-channels-overlays.js'
import { createHostSlotPortBridge } from './host-slot-port-bridge.js'

/**
 * Cap on pre-handshake queued sends. 128 comfortably covers any sane toolbar
 * boot sequence while bounding what a page whose handshake never completes
 * can make the isolated world retain. Overflow policy: drop the NEWEST
 * envelope (queued first-comers survive), one console.warn per load.
 */
export const HOST_TOOLBAR_PENDING_LIMIT = 128

/**
 * Subscribe the handshake channel and expose the page bridge. Call ONLY from
 * a passing toolbar-runtime guard (`activateHostToolbarRuntime`) — a failing
 * guard must leave zero footprint (no bridge key, no IPC listener).
 */
export function installHostToolbarPortBridge(): void {
  createHostSlotPortBridge({
    bridgeKey: 'diminaHostToolbar',
    channel: ViewChannel.HostToolbarPort,
    pendingLimit: HOST_TOOLBAR_PENDING_LIMIT,
    label: 'host-toolbar',
  })
}
