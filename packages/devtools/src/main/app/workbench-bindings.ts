/**
 * Contribution-binding layer for `workbench()`. Wires the three runtime
 * contribution kinds collected into `DeferredContributions` to their backends:
 *
 *  - `simulatorApis` → devtools-native `ctx.simulatorApis.register(name, handler)`
 *    (real path; projected into the mini-program as `wx.<name>`).
 *  - `hostServices`  → injected workbench `TypedIpcRegistry.handle(
 *    '__workbench:host:<name>', handler)` — trusted-webview host RPC carried over
 *    the WireTransport.
 *  - `events`        → injected workbench `EventBus.bindDeclaredEvents(events)` —
 *    main→webview one-way declared push.
 *
 * Pure w.r.t. electron: all backends are injected. `dispose()` unbinds the host
 * RPC handlers and unregisters the simulator APIs (idempotent).
 */
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { DeferredContributions } from './workbench-config-adapter.js'

/** Channel prefix shared with the WireTransport host-RPC route (see workbench-app). */
const HOST_CHANNEL_PREFIX = '__workbench:host:'

type AnyHandler = (...args: unknown[]) => unknown

/**
 * The injected ipc registry — the concrete `InMemoryTypedIpcRegistry` exposes
 * both `handle` and `invoke` (the public `TypedIpcRegistry` type omits `invoke`).
 */
export interface HostRpcRegistry {
  handle(channel: string, handler: AnyHandler): { dispose(): void }
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

export interface DeclaredEventBus {
  bindDeclaredEvents(events: readonly unknown[]): void
}

export interface BindContributionsDeps {
  ctx: WorkbenchContext
  deferred: Pick<DeferredContributions, 'simulatorApis' | 'hostServices' | 'events'>
  ipc: HostRpcRegistry
  bus: DeclaredEventBus
}

export interface BindContributionsResult {
  dispose(): void
  /** Main-process host-RPC dispatch; wired into `runtime.call.host`. */
  callHost(name: string, ...args: unknown[]): Promise<unknown>
}

export function bindContributions(deps: BindContributionsDeps): BindContributionsResult {
  const { ctx, deferred, ipc, bus } = deps
  const teardown: Array<() => void> = []

  if (deferred.simulatorApis) {
    for (const [name, handler] of Object.entries(deferred.simulatorApis)) {
      const unregister = ctx.simulatorApis.register(name, handler as AnyHandler)
      teardown.push(unregister)
    }
  }

  if (deferred.hostServices) {
    for (const [name, handler] of Object.entries(deferred.hostServices)) {
      const d = ipc.handle(`${HOST_CHANNEL_PREFIX}${name}`, handler as AnyHandler)
      teardown.push(() => d.dispose())
    }
  }

  if (deferred.events) {
    bus.bindDeclaredEvents(deferred.events)
  }

  let disposed = false
  return {
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const fn of teardown) {
        try {
          fn()
        }
        catch (e) {
          console.error('[workbench] contribution teardown failed:', e)
        }
      }
    },
    callHost: (name, ...args) => ipc.invoke(`${HOST_CHANNEL_PREFIX}${name}`, ...args),
  }
}
