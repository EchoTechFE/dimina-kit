/**
 * Shared implementation behind every host-slot page bridge (toolbar/sidebar/
 * dialog): the MessagePort handshake, pending-queue-with-bounded-overflow,
 * handler registry and `{ send, onMessage }` contextBridge exposure are
 * IDENTICAL across slots — only the bridge key, handshake channel, queue cap
 * and overflow-warning label differ. Each slot's own `host-*-port.ts` stays
 * the frozen public surface (see its own "PUBLIC SURFACE EVOLUTION RULE"
 * doc-comment) and calls this factory with its own constants; this module has
 * no public-surface contract of its own.
 */
import { contextBridge, ipcRenderer } from 'electron'

export interface HostSlotPortBridgeOptions {
  /** contextBridge key the page-facing API is exposed under, e.g. 'diminaHostToolbar'. */
  bridgeKey: string
  /** main → renderer per-load handshake channel, e.g. ViewChannel.HostToolbarPort. */
  channel: string
  /** Cap on pre-handshake queued sends; overflow drops the NEWEST envelope. */
  pendingLimit: number
  /** Slot label used in the overflow console.warn, e.g. 'host-toolbar'. */
  label: string
}

/**
 * Subscribe the handshake channel and expose the page bridge. Call ONLY from
 * a passing per-slot runtime guard — a failing guard must leave zero
 * footprint (no bridge key, no IPC listener), so this factory itself does no
 * guard checking; the caller decides whether to call it at all.
 */
export function createHostSlotPortBridge(opts: HostSlotPortBridgeOptions): void {
  const { bridgeKey, channel, pendingLimit, label } = opts
  let activePort: MessagePort | null = null
  const pending: Array<{ channel: string; payload: unknown }> = []
  // One overflow warning per load (this installer runs once per document) —
  // a runaway page send-loop must not get per-drop console spam.
  let warnedPendingOverflow = false
  const handlers: Array<{ channel: string; handler: (payload: unknown) => void }> = []

  // Entry-waist channel validation, parity with the main side's `onMessage`
  // guard (same TypeError, message names `channel`). Runs BEFORE any state is
  // touched (no queue slot, no registry entry), in both port states — a page
  // author's typo throws at the call site instead of vanishing into main's
  // silent inbound drop.
  function assertValidChannel(method: string, ch: unknown): asserts ch is string {
    if (typeof ch !== 'string' || ch === '') {
      throw new TypeError(`${bridgeKey}.${method}: channel must be a non-empty string`)
    }
  }

  const dispatch = (data: unknown): void => {
    // Defensive symmetry with main: drop anything that is not an object
    // envelope with a string channel — never throw in the dispatcher.
    if (typeof data !== 'object' || data === null) return
    const { channel: ch, payload } = data as { channel?: unknown; payload?: unknown }
    if (typeof ch !== 'string') return
    for (const entry of [...handlers]) {
      if (entry.channel === ch) entry.handler(payload)
    }
  }

  const onPortMessage = (event: MessageEvent): void => {
    dispatch(event.data)
  }

  ipcRenderer.on(channel, (event) => {
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
  contextBridge.exposeInMainWorld(bridgeKey, {
    send(ch: string, payload: unknown): void {
      assertValidChannel('send', ch)
      const envelope = { channel: ch, payload }
      if (activePort) {
        activePort.postMessage(envelope)
        return
      }
      // Bounded queue: drop the NEWEST send on overflow (FIFO first-comers
      // survive), warn once per load, never throw into page code.
      if (pending.length >= pendingLimit) {
        if (!warnedPendingOverflow) {
          warnedPendingOverflow = true
          console.warn(
            `[dimina-devtools] ${label} pending queue full (${pendingLimit}); ` +
              'dropping further pre-handshake send() calls until the port arrives',
          )
        }
        return
      }
      pending.push(envelope)
    },
    onMessage(ch: string, handler: (payload: unknown) => void): () => void {
      assertValidChannel('onMessage', ch)
      const entry = { channel: ch, handler }
      handlers.push(entry)
      return () => {
        const i = handlers.indexOf(entry)
        if (i >= 0) handlers.splice(i, 1)
      }
    },
  })
}
