/**
 * Native-host SERVICE-layer console capture via CDP.
 *
 * The embedded Chrome DevTools front-end is attached natively to the service
 * host, so the service layer's `console.*` already displays there with correct
 * source attribution + sourcemaps — UNLESS something rewrites `console.*`. The
 * old `service-host/preload.cjs` monkeypatch did exactly that (wrapping each
 * level to also post the entry to main), which made DevTools attribute every
 * service log to the wrapper line (`preload.cjs:237`) instead of the developer's
 * source. That monkeypatch is removed; this service replaces its ONE remaining
 * job — feeding service-layer entries to the console fan-out (automation
 * `App.logAdded`) — by capturing `Runtime.consoleAPICalled` over an in-process
 * CDP session instead. Capturing at the CDP layer adds no stack frame, so native
 * attribution in the DevTools console is preserved (verified: an in-process
 * `debugger.attach('1.3')` coexists with the custom-host DevTools front-end on
 * the same wc — Electron multi-client CDP).
 *
 * Lifecycle: installed when the right-panel DevTools is pointed at a service host
 * wc (`view-manager.pointNativeDevtoolsAtServiceWc`) and stopped when that source
 * is closed / swapped (pre-warm pool recycles the service window). `stop()` is
 * idempotent.
 */
import type { WebContents } from 'electron'
import type { ConnectionRegistry } from '@dimina-kit/electron-deck/main'
import type { GuestConsoleEntry } from '../console-forward/index.js'
import {
  RENDER_FORWARD_SOURCE_URL,
  mapConsoleApiType,
  needsDeepFetch,
  remoteObjectToValue,
  isRenderForwardEvent,
  type RemoteObjectLike,
  type ConsoleApiParamsLike,
} from './console-api.js'

export interface ServiceConsoleForwardDeps {
  /** The service host wc whose `console.*` we capture (top-level BrowserWindow wc). */
  serviceWc: WebContents
  /** Sink for each captured service entry (wired to `consoleForwarder.emit`). */
  emit: (entry: GuestConsoleEntry) => void
  /** Connection registry — binds teardown to the service wc's destroy ('closed'). */
  connections?: ConnectionRegistry
}

export interface ServiceConsoleForwardHandle {
  /** Detach the CDP session (if we attached it) and stop capturing. Idempotent. */
  stop(): void
}

/**
 * Attach an in-process CDP session to `serviceWc`, enable Runtime, and forward
 * every `Runtime.consoleAPICalled` to `emit` as a `source:'service'` entry —
 * EXCEPT the render→service `[视图]` re-injection (skipped via sentinel so it is
 * not double-broadcast). Object args are deep-serialized via
 * `Runtime.callFunctionOn` on our OWN session (the objectId can't be released by
 * the front-end), falling back to the shallow inline value on failure.
 */
export function installServiceConsoleForward(deps: ServiceConsoleForwardDeps): ServiceConsoleForwardHandle {
  const { serviceWc, emit, connections } = deps
  let disposed = false
  // Did WE attach the session (vs. it already being attached by someone else)?
  // Only detach what we own.
  let selfAttached = false
  // Process events in arrival order even though arg resolution is async, so the
  // forwarded sequence matches the order the developer logged.
  let tail: Promise<void> = Promise.resolve()
  let closedSub: { dispose(): void } | undefined

  function usableDebugger(): boolean {
    try {
      if (serviceWc.isDestroyed()) return false
      if (serviceWc.debugger.isAttached()) return true
    } catch {
      return false
    }
    try {
      serviceWc.debugger.attach('1.3')
      selfAttached = true
      return true
    } catch {
      // Race: someone attached between the check and here → still usable.
      try { return serviceWc.debugger.isAttached() } catch { return false }
    }
  }

  /** Deep-serialize one arg; best-effort, never throws. */
  async function resolveArg(ro: RemoteObjectLike): Promise<unknown> {
    if (!needsDeepFetch(ro)) return remoteObjectToValue(ro)
    try {
      const res = (await serviceWc.debugger.sendCommand('Runtime.callFunctionOn', {
        objectId: ro.objectId,
        functionDeclaration: 'function () { return this }',
        returnByValue: true,
      })) as { result?: { value?: unknown } }
      if (res && res.result && 'value' in res.result) return res.result.value
    } catch {
      // Object released / host navigating — fall back to the shallow value.
    }
    return remoteObjectToValue(ro)
  }

  async function handleConsoleApi(params: ConsoleApiParamsLike): Promise<void> {
    if (disposed) return
    // Skip the render→service `[视图]` re-injection — the original render entry
    // already reached every consumer; re-forwarding would duplicate it.
    if (isRenderForwardEvent(params, RENDER_FORWARD_SOURCE_URL)) return
    const level = mapConsoleApiType(params.type)
    const rawArgs = Array.isArray(params.args) ? params.args : []
    let args: unknown[]
    try {
      args = await Promise.all(rawArgs.map((a) => resolveArg(a)))
    } catch {
      args = rawArgs.map((a) => remoteObjectToValue(a))
    }
    if (disposed) return
    emit({ source: 'service', level, args, ts: Date.now() })
  }

  const onMessage = (_event: unknown, method: string, params: unknown): void => {
    if (disposed) return
    if (method !== 'Runtime.consoleAPICalled') return
    const p = params as ConsoleApiParamsLike
    tail = tail.then(() => handleConsoleApi(p)).catch(() => { /* never break the chain */ })
  }

  function stop(): void {
    if (disposed) return
    disposed = true
    try { closedSub?.dispose() } catch { /* gone */ }
    try { serviceWc.debugger.removeListener('message', onMessage) } catch { /* gone */ }
    if (selfAttached) {
      try {
        if (!serviceWc.isDestroyed() && serviceWc.debugger.isAttached()) serviceWc.debugger.detach()
      } catch { /* already detached / destroyed */ }
      selfAttached = false
    }
  }

  if (!usableDebugger()) {
    disposed = true
    return { stop() { /* nothing attached */ } }
  }

  try {
    serviceWc.debugger.on('message', onMessage)
  } catch {
    stop()
    return { stop() { /* already cleaned */ } }
  }

  // Enable Runtime so consoleAPICalled flows. Best-effort — a mid-destroy host
  // rejects, in which case there's simply nothing to capture.
  serviceWc.debugger.sendCommand('Runtime.enable').catch(() => { /* host gone */ })

  // Bind teardown to the service wc's real destroy. The service window is
  // pool-recycled, but 'closed' fires only on hard destroy — the right lifetime
  // for a session we attached to THIS wc. `on('closed')` returns a handle whose
  // dispose() removes the listener WITHOUT firing it.
  try {
    if (connections) closedSub = connections.acquire(serviceWc).on('closed', stop)
    else serviceWc.once('destroyed', stop)
  } catch { /* fake/minimal wc in tests */ }

  return { stop }
}
