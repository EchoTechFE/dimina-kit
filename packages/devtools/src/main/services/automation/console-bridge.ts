import type { WebContents } from 'electron'
import type { ConnectionRegistry } from '@dimina-kit/electron-deck/main'
import { SimulatorChannel } from '../../../shared/ipc-channels.js'
import type { ConsoleForwarder, GuestConsoleEntry } from '../console-forward/index.js'
import type { RpcEvent } from './shared.js'

/** The slice of a window context the two console taps read. */
export interface ConsoleTargetContext {
  consoleForwarder?: ConsoleForwarder
  connections: ConnectionRegistry
}

/**
 * How often an idle connection re-checks its target for a console to attach
 * to. A connection that never sends a message (a script that only listens for
 * logs) has no other moment to notice its window's simulator appearing or
 * being replaced by a rebuild.
 */
const SYNC_INTERVAL_MS = 1000

/**
 * The `App.logAdded` stream of ONE automation connection, taken from the same
 * window that connection's commands reach.
 *
 * Two taps, because the two architectures deliver guest console differently:
 *   - native-host: the render/service preloads post to main, bridge-router
 *     routes into the window's always-on ConsoleForwarder, and we subscribe.
 *   - default dimina-fe: the page/service console flows through the simulator
 *     guest's `ipc-message-host` channel, so we listen on that webContents.
 * Both are re-pointed by `sync()`, which is what keeps the log stream and the
 * command stream on the same window as the target and its simulator change.
 */
export interface ConsoleBridge {
  /** Re-point both taps at the connection's current target. */
  sync(): void
  dispose(): void
}

export function createConsoleBridge<T extends ConsoleTargetContext>(
  target: () => T | null,
  simulatorOf: (ctx: T) => WebContents | null,
  emit: (event: RpcEvent) => void,
): ConsoleBridge {
  let subscribedForwarder: ConsoleForwarder | null = null
  let forwarderSub: { dispose: () => void } | undefined
  let attachedSim: WebContents | null = null
  let simHandler: ((event: unknown, channel: string, data: unknown) => void) | null = null
  // The destroyed-teardown is owned by the sim's connection rather than a
  // bespoke `sim.once('destroyed')`, so it cannot accumulate across re-attaches.
  let simDestroyedDisposer: { dispose: () => void | Promise<void> } | null = null

  function logAdded(entry: { level?: string; args?: unknown[] } | undefined): void {
    const e = entry ?? {}
    emit({ method: 'App.logAdded', params: { type: e.level || 'log', args: e.args || [] } })
  }

  // Keyed on the forwarder itself, not the context: a window is wired with its
  // forwarder after the context exists, so a context-identity check would miss
  // the forwarder arriving on a context we already looked at.
  function syncForwarder(ctx: T | null): void {
    const forwarder = ctx?.consoleForwarder ?? null
    if (forwarder === subscribedForwarder) return
    forwarderSub?.dispose()
    subscribedForwarder = forwarder
    forwarderSub = forwarder?.subscribe((entry: GuestConsoleEntry) => logAdded(entry))
  }

  function detachSim(): void {
    if (attachedSim && simHandler) {
      try {
        if (!attachedSim.isDestroyed()) {
          ;(attachedSim as NodeJS.EventEmitter).removeListener('ipc-message-host', simHandler)
        }
      } catch { /* noop */ }
    }
    try { simDestroyedDisposer?.dispose() } catch { /* noop */ }
    attachedSim = null
    simHandler = null
    simDestroyedDisposer = null
  }

  function syncSim(ctx: T | null): void {
    const sim = ctx ? simulatorOf(ctx) : null
    const next = sim && !sim.isDestroyed() ? sim : null
    if (next === attachedSim) return
    detachSim()
    if (!next || !ctx) return

    const onIpcMessageHost = (_event: unknown, channel: string, data: unknown): void => {
      if (channel !== SimulatorChannel.Console) return
      logAdded(data as { level?: string; args?: unknown[] })
    }
    attachedSim = next
    simHandler = onIpcMessageHost
    ;(next as NodeJS.EventEmitter).on('ipc-message-host', onIpcMessageHost)
    simDestroyedDisposer = ctx.connections.acquire(next).own(() => {
      // Dead webContents: drop the refs (removeListener on it would throw) and
      // let the next sync attach to the replacement.
      attachedSim = null
      simHandler = null
      simDestroyedDisposer = null
    })
  }

  function sync(): void {
    const ctx = target()
    syncForwarder(ctx)
    syncSim(ctx)
  }

  const timer = setInterval(sync, SYNC_INTERVAL_MS)

  return {
    sync,
    dispose() {
      clearInterval(timer)
      detachSim()
      forwarderSub?.dispose()
      forwarderSub = undefined
      subscribedForwarder = null
    },
  }
}
