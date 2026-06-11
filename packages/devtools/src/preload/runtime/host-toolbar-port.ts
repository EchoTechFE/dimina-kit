/**
 * Preload side of the host-toolbar gated narrow channel.
 *
 * Receives the per-load MessagePort main transfers on `did-finish-load`
 * (`ViewChannel.HostToolbarPort`, `event.ports[0]`) and bridges it to the page
 * as `window.diminaHostToolbar` — EXACTLY `{ send, onMessage }`, functions
 * only. The raw MessagePort never crosses into the main world: the page only
 * ever talks through these two functions, so the `{ channel, payload }`
 * envelope stays the single waist (same posture as the main side's
 * host-toolbar-port-channel.ts).
 *
 * Ordering reality this module absorbs (spike .repro/wave3-spike):
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
 */

import { contextBridge, ipcRenderer } from 'electron'
import { ViewChannel } from '../../shared/ipc-channels.js'

const BRIDGE_KEY = 'diminaHostToolbar'

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
  let activePort: MessagePort | null = null
  const pending: Array<{ channel: string; payload: unknown }> = []
  // One overflow warning per load (this installer runs once per document) —
  // a runaway page send-loop must not get per-drop console spam.
  let warnedPendingOverflow = false
  const handlers: Array<{ channel: string; handler: (payload: unknown) => void }> = []

  const dispatch = (data: unknown): void => {
    // Defensive symmetry with main: drop anything that is not an object
    // envelope with a string channel — never throw in the dispatcher.
    if (typeof data !== 'object' || data === null) return
    const { channel, payload } = data as { channel?: unknown; payload?: unknown }
    if (typeof channel !== 'string') return
    for (const entry of [...handlers]) {
      if (entry.channel === channel) entry.handler(payload)
    }
  }

  const onPortMessage = (event: MessageEvent): void => {
    dispatch(event.data)
  }

  ipcRenderer.on(ViewChannel.HostToolbarPort, (event) => {
    const port = event.ports[0]
    if (!port) return
    // Same-load duplicate handshake: the LATER port wins. Main closed (or is
    // about to close) its end of the old pair — detach and stop writing to it.
    if (activePort) {
      try {
        activePort.removeEventListener('message', onPortMessage)
        activePort.close()
      } catch {
        /* already dead */
      }
    }
    activePort = port
    // addEventListener (not onmessage) keeps the handler removable on
    // re-handshake; it REQUIRES start() or inbound never delivers.
    port.addEventListener('message', onPortMessage)
    port.start()
    // Flush sends issued before the port arrived, in order.
    while (pending.length > 0) {
      const envelope = pending.shift()!
      port.postMessage(envelope)
    }
  })

  // EXACTLY { send, onMessage } — functions only; the port stays in the
  // isolated world.
  contextBridge.exposeInMainWorld(BRIDGE_KEY, {
    send(channel: string, payload: unknown): void {
      const envelope = { channel, payload }
      if (activePort) {
        activePort.postMessage(envelope)
        return
      }
      // Bounded queue: drop the NEWEST send on overflow (FIFO first-comers
      // survive), warn once per load, never throw into page code.
      if (pending.length >= HOST_TOOLBAR_PENDING_LIMIT) {
        if (!warnedPendingOverflow) {
          warnedPendingOverflow = true
          console.warn(
            `[dimina-devtools] host-toolbar pending queue full (${HOST_TOOLBAR_PENDING_LIMIT}); ` +
              'dropping further pre-handshake send() calls until the port arrives',
          )
        }
        return
      }
      pending.push(envelope)
    },
    onMessage(channel: string, handler: (payload: unknown) => void): () => void {
      const entry = { channel, handler }
      handlers.push(entry)
      return () => {
        const i = handlers.indexOf(entry)
        if (i >= 0) handlers.splice(i, 1)
      }
    },
  })
}
