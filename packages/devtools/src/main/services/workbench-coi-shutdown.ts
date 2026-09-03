/**
 * Shutdown bookkeeping for the workbench COI bridge, at two levels.
 *
 * A project window's bridge is closed as part of that window's teardown, which
 * awaits it. Two things pull against each other at that moment. `/__fs/watch`
 * is an SSE stream that only ever ends when its client disconnects, so waiting
 * on it waits on the editor being destroyed in the same breath — the window
 * hangs. Dropping every socket outright instead loses a `/__fs/write` whose
 * body is still arriving, which is the file the user just saved.
 *
 * So neither extreme: {@link CoiServerShutdown.drain} ends the streams this
 * owner started, lets a request already being served finish, and returns once
 * it has — or once the grace window expires, so teardown is bounded no matter
 * what a client does. The shared listener behind every window (see
 * workbench-coi-host.ts) then uses {@link CoiServerShutdown.close}, which adds
 * the server close and takes the sockets that outlived it.
 */
import type http from 'node:http'

/** How long a request already in flight may hold up the window's teardown. */
const DEFAULT_GRACE_MS = 2_000

export interface CoiServerShutdown {
  /** A live `/__fs/watch` stream, with the call that ends it server-side. */
  trackWatchStream: (res: http.ServerResponse, endStream: () => void) => void
  /** A one-shot request whose response must be allowed to land. */
  trackRequest: (res: http.ServerResponse) => void
  /**
   * True once {@link drain} has started. The owner refuses new requests from
   * here on: this bridge is bound to a window that is going away, and a
   * request accepted now would act on a project the user has closed.
   */
  readonly closing: boolean
  /**
   * End the tracked streams and wait for the tracked one-shot responses to
   * land, bounded by the grace window. Leaves the listener alone — one window
   * going away must not take the shared server with it.
   */
  drain: () => Promise<void>
  /** {@link drain}, plus closing the server and taking any surviving sockets. */
  close: (server: http.Server) => Promise<void>
}

export function createCoiServerShutdown(graceMs: number = DEFAULT_GRACE_MS): CoiServerShutdown {
  const watchStreams = new Set<() => void>()
  const inFlight = new Set<http.ServerResponse>()
  let onDrained: (() => void) | null = null
  let closing = false

  const drain = (): Promise<void> =>
    new Promise<void>((resolve) => {
      closing = true
      for (const endStream of watchStreams) endStream()
      watchStreams.clear()
      // Nothing is being served: the sockets that remain are a client's to
      // keep alive, and waiting on them is waiting on nobody.
      if (inFlight.size === 0) {
        resolve()
        return
      }
      let deadline: ReturnType<typeof setTimeout> | null = null
      const finish = (): void => {
        onDrained = null
        if (deadline) clearTimeout(deadline)
        resolve()
      }
      const expire = (): void => {
        // The grace window is up and something is still mid-request — a client
        // that stalled halfway through a body, most likely. Destroying it here
        // is the point: the handler still holds the closing window's project,
        // so a body that lands minutes from now would write into a project the
        // user has closed, and the socket would outlive the window on the
        // shared listener.
        for (const res of [...inFlight]) res.destroy()
        inFlight.clear()
        finish()
      }
      deadline = setTimeout(expire, graceMs)
      onDrained = finish
    })

  return {
    get closing() {
      return closing
    },
    trackWatchStream(res, endStream) {
      watchStreams.add(endStream)
      res.on('close', () => watchStreams.delete(endStream))
    },
    trackRequest(res) {
      inFlight.add(res)
      res.on('close', () => {
        inFlight.delete(res)
        if (inFlight.size === 0) onDrained?.()
      })
    },
    drain,
    async close(server) {
      // Stop accepting first, so nothing new arrives during the drain; the
      // callback only fires once every connection is gone, which is why the
      // sockets are taken below rather than waited on.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      await drain()
      server.closeAllConnections()
      await closed
    },
  }
}
