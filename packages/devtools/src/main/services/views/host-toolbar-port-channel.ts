/**
 * Gated narrow channel between the main process and the host-toolbar
 * WebContentsView's page, over a per-load transferred MessagePort.
 *
 * Why a MessagePort and not plain IPC: the toolbar page is HOST-ARBITRARY
 * content. A dedicated port pair gives it exactly one pipe whose main-side end
 * lives in this module — the page never gains a generic `ipcRenderer` reach
 * into the ~72 internal devtools channels, and main-side inbound traffic is
 * validated at this single waist.
 *
 * Lifecycle (per-load handshake):
 *  - On every toolbar-wc `did-finish-load` main builds a fresh
 *    `MessageChannelMain`, transfers port2 to the new document via
 *    `wc.postMessage(ViewChannel.HostToolbarPort, null, [port2])`, keeps
 *    port1 and `start()`s it. The previous port1 (if any) is closed first —
 *    its document is gone.
 *  - `onMessage` registrations are CONTROL-level (this module's registry), not
 *    per-port: they may be made before any view exists and survive page
 *    reloads / wc rebuilds, because each new handshake dispatches into the
 *    same registry.
 *  - `send` is gated and non-queueing: `false` means "not delivered, ever" —
 *    no toolbar view is conjured, nothing is buffered for a later handshake.
 *  - A port1 `'close'` event (the renderer end died without a re-handshake
 *    yet) drops the live-port reference so `send` reports `false` instead of
 *    posting into a dead pipe.
 *  - NAVIGATION INVALIDATES THE PORT. The port pair belongs to one DOCUMENT,
 *    so starting a navigation that replaces that document closes port1 and
 *    `send` returns `false` until the new document's `did-finish-load`
 *    handshake. Two paths:
 *      (a) host-initiated `hostToolbar.loadURL/loadFile` calls `invalidate()`
 *          synchronously AT INITIATION (view-manager does this before the
 *          `webContents.loadURL/loadFile` await), so a same-tick `send` can
 *          never report `true` for an envelope posted into the document the
 *          load is about to replace;
 *      (b) page-initiated navigation (location.href / reload) is caught by a
 *          `did-start-navigation` listener — guarded to the ACTIVE wc,
 *          main-frame, cross-document only. Same-document navigations
 *          (anchors, pushState, history) and subframe navigations do NOT
 *          invalidate: the document the port lives in survives those, and no
 *          main-frame `did-finish-load` would follow to ever restore the
 *          channel.
 *
 * Envelope both directions: `{ channel: string, payload: unknown }`. Inbound
 * data that is not an object with a string `channel` is DROPPED without
 * throwing (the counterpart is arbitrary host content).
 */

import { MessageChannelMain } from 'electron'
import type { MessagePortMain, WebContents } from 'electron'
import { ViewChannel } from '../../../shared/ipc-channels.js'

/** Handle returned by `onMessage`; `dispose()` detaches (idempotent). */
export interface HostToolbarMessageSubscription {
  dispose(): void
}

export interface HostToolbarPortChannel {
  /**
   * Hook a freshly created toolbar webContents: registers the
   * `did-finish-load` (per-load handshake) and `destroyed` (drop the live
   * port) listeners via `wc.on(...)`. Call exactly once per wc, right after
   * the view is created.
   */
  attach(wc: WebContents): void
  /**
   * Drop the live port NOW (close + clear): the document it belongs to is
   * being replaced. Called by view-manager synchronously when the HOST
   * initiates a `loadURL`/`loadFile` — the host-initiated half of the
   * navigation-invalidates contract (the page-initiated half is the
   * `did-start-navigation` listener `attach` installs). `send` returns false
   * from this call until the next `did-finish-load` handshake. Idempotent.
   */
  invalidate(): void
  /** Register a control-level inbound handler for `channel`. */
  onMessage(
    channel: string,
    handler: (payload: unknown) => void,
  ): HostToolbarMessageSubscription
  /**
   * Post `{ channel, payload }` to the toolbar page over the live port.
   * Returns false (delivering NOTHING, creating NOTHING) when there is no
   * live toolbar wc, the current load's handshake hasn't completed, or a
   * document-replacing navigation is in flight (see `invalidate`).
   */
  send(channel: string, payload: unknown): boolean
  /**
   * Teardown (view-manager `disposeAll`): close the live port, sweep the
   * handler registry, refuse further handshakes. Subsequent `send` returns
   * false; late `dispose()` of an old subscription stays a no-op.
   */
  dispose(): void
}

export function createHostToolbarPortChannel(opts: {
  /**
   * Is `wc` still the manager's CURRENT live toolbar webContents? Guards a
   * stale wc's late `did-finish-load` from hijacking the channel after a
   * rebuild swapped the view out underneath it.
   */
  isCurrent: (wc: WebContents) => boolean
}): HostToolbarPortChannel {
  let activePort: MessagePortMain | null = null
  /** The wc that owns `activePort` (so a stale wc's `destroyed` can't drop a successor's port). */
  let activeWc: WebContents | null = null
  let disposed = false
  // Array (not Map<channel, Set>) so the same handler function may be
  // registered twice and each registration disposes independently.
  const handlers: Array<{ channel: string; handler: (payload: unknown) => void }> = []

  function dispatch(data: unknown): void {
    // Inbound waist: the toolbar page is host-arbitrary content — anything
    // that is not an object envelope with a string channel is dropped.
    if (typeof data !== 'object' || data === null) return
    const { channel, payload } = data as { channel?: unknown; payload?: unknown }
    if (typeof channel !== 'string') return
    // Snapshot so a handler that (un)subscribes mid-dispatch can't skew iteration.
    for (const entry of [...handlers]) {
      if (entry.channel === channel) entry.handler(payload)
    }
  }

  function dropActivePort(close: boolean): void {
    const port = activePort
    activePort = null
    activeWc = null
    if (close && port) {
      try {
        port.close()
      } catch {
        /* already closed */
      }
    }
  }

  function handshake(wc: WebContents): void {
    if (disposed) return
    if (!opts.isCurrent(wc)) return
    // The previous load's document is gone; its port goes with it.
    dropActivePort(true)
    const { port1, port2 } = new MessageChannelMain()
    port1.on('message', (event) => {
      dispatch(event.data)
    })
    // Renderer end died without a re-handshake (page crash / wc close): drop
    // the reference so send() reports false instead of posting into the void.
    port1.on('close', () => {
      if (activePort === port1) dropActivePort(false)
    })
    wc.postMessage(ViewChannel.HostToolbarPort, null, [port2])
    port1.start()
    activePort = port1
    activeWc = wc
  }

  return {
    attach(wc: WebContents): void {
      wc.on('did-finish-load', () => handshake(wc))
      // Page-initiated navigation (location.href / reload): the document the
      // port lives in is being replaced — invalidate so send() reports false
      // through the navigation window instead of confirming delivery into a
      // document being torn down. TRIPLE guard, because over-invalidating
      // mutes the channel FOREVER (no main-frame did-finish-load follows to
      // re-handshake):
      //  - activeWc: a stale wc's late event must not drop a successor's port
      //    (same discipline as the 'destroyed' handler below);
      //  - cross-document only: anchors/pushState/history keep the document;
      //  - main frame only: an <iframe> navigating keeps the main document.
      // Reads the details object (electron >= 12 shape); falls back to the
      // deprecated positional args (`isInPlace` === details.isSameDocument).
      wc.on(
        'did-start-navigation',
        (details, _url, isInPlace, isMainFramePositional) => {
          if (activeWc !== wc) return
          const isSameDocument =
            typeof details?.isSameDocument === 'boolean'
              ? details.isSameDocument
              : isInPlace
          const isMainFrame =
            typeof details?.isMainFrame === 'boolean'
              ? details.isMainFrame
              : isMainFramePositional
          if (isSameDocument || !isMainFrame) return
          dropActivePort(true)
        },
      )
      wc.on('destroyed', () => {
        if (activeWc === wc) dropActivePort(true)
      })
    },

    invalidate(): void {
      dropActivePort(true)
    },

    onMessage(channel, handler): HostToolbarMessageSubscription {
      if (typeof channel !== 'string' || channel === '') {
        throw new TypeError(
          'hostToolbar.onMessage: channel must be a non-empty string',
        )
      }
      const entry = { channel, handler }
      handlers.push(entry)
      return {
        dispose(): void {
          const i = handlers.indexOf(entry)
          if (i >= 0) handlers.splice(i, 1)
        },
      }
    },

    send(channel, payload): boolean {
      if (!activePort) return false
      activePort.postMessage({ channel, payload })
      return true
    },

    dispose(): void {
      disposed = true
      dropActivePort(true)
      handlers.length = 0
    },
  }
}
