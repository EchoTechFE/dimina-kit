/**
 * Native-host console forwarder.
 *
 * Under native-host the guest console doesn't flow through the simulator guest's
 * `ipc-message-host` channel — there is no Worker/MiniApp in the simulator
 * webview. Entries reach `ctx.guestConsole.emit` two ways:
 *   - RENDER layer (`source:'render'`): render-host/preload.cjs monkeypatches
 *     `console.*` and posts each entry to main as a `consoleLog` message.
 *   - SERVICE layer (`source:'service'`): captured in main via CDP
 *     `Runtime.consoleAPICalled` (services/service-console) — NOT a preload
 *     monkeypatch, so the embedded DevTools keeps native source attribution.
 *     (service-host/preload.cjs still posts uncaught error/unhandledrejection as
 *     `source:'service'` `consoleLog` messages — CDP doesn't report those.)
 * This service OWNS that sink (always-on, native-host is the sole runtime) and
 * fans each entry out to:
 *
 *   1. A built-in render→service forward: render-layer entries (`source:'render'`)
 *      are re-emitted into the service-host window's own `console` with a
 *      `[视图]` prefix. The right-panel embedded Chrome DevTools is attached to
 *      the service host, so the service layer already shows natively there; this
 *      pulls the render (view) layer into that SAME panel, prefixed so the
 *      DevTools filter can separate the two layers.
 *
 *   2. Zero or more external subscribers (e.g. the automation WS server, which
 *      rebroadcasts every entry as an `App.logAdded` event). Subscribers used to
 *      each set `ctx.guestConsole` directly and clobber one another; now they
 *      register here so render + service both reach every consumer.
 *
 * ── Loop-safety invariant ───────────────────────────────────────────────────
 * The render→service forward injects `console[…]('[视图]', …)` INTO the service
 * host. The service-console CDP capture attached to that host would re-capture
 * that call as a fresh `source:'service'` entry and re-broadcast it (duplicate).
 * Two guards prevent that:
 *   1. The injected script is stamped with `//# sourceURL=RENDER_FORWARD_SOURCE_URL`
 *      (see `buildForwardScript`); service-console skips any `consoleAPICalled`
 *      whose top frame is that sentinel, so the `[视图]` line is never re-emitted.
 *   2. This forwarder re-injects ONLY `source:'render'` entries — service entries
 *      are already shown natively in the attached DevTools, so forwarding them
 *      would duplicate. (Do NOT forward `source:'service'`.)
 */
import type { WebContents } from 'electron'
import { DisposableRegistry, toDisposable, type Disposable } from '@dimina-kit/electron-deck/main'
import type { BridgeRouterHandle } from '../../ipc/bridge-router.js'
import { RENDER_FORWARD_SOURCE_URL } from '../service-console/console-api.js'

/**
 * One console entry posted by a guest preload. Shape mirrors
 * render-host/preload.cjs + service-host/preload.cjs `emitConsoleLog`:
 *   - `source`  which layer it came from ('render' | 'service'); ONLY 'render'
 *               is forwarded into the service host (see loop-safety above).
 *   - `bridgeId` present for render entries; identifies the owning page so we
 *               can target the matching app's service host (multi-app safe).
 *   - `level`   console method name ('log' | 'warn' | 'error' | 'info' | 'debug').
 *   - `args`    already-`safeSerialize`d arguments (structured-cloneable).
 */
export interface GuestConsoleEntry {
  source?: string
  bridgeId?: string
  level?: string
  args?: unknown[]
  ts?: number
}

/** A consumer of every guest console entry (render AND service). */
export type ConsoleSink = (entry: GuestConsoleEntry) => void

export interface ConsoleForwarder extends Disposable {
  /**
   * The single sink bridge-router invokes (wired onto `ctx.guestConsole.emit`).
   * Fans every entry out to subscribers, then runs the render→service forward.
   */
  emit(entry: unknown): void
  /**
   * Register an external sink (e.g. automation WS broadcast). Returns a
   * Disposable that unregisters it. Sinks see EVERY entry (both layers) — the
   * render→service forward is internal and not exposed as a sink.
   */
  subscribe(sink: ConsoleSink): Disposable
}

/** Console levels we re-emit into the service host. Anything else maps to 'log'. */
const FORWARDABLE_LEVELS = new Set(['log', 'warn', 'error', 'info', 'debug'])

/**
 * Build the `executeJavaScript` source that re-emits a render entry inside the
 * service host. Args are carried as a JSON string and parsed service-side, so no
 * guest-controlled value is ever interpolated into executable JS — the only
 * thing that reaches the parser is a JSON literal. The `[视图]` prefix lets the
 * DevTools console filter isolate the render layer.
 */
function buildForwardScript(level: string, args: unknown[]): string {
  const method = FORWARDABLE_LEVELS.has(level) ? level : 'log'
  // JSON.stringify('…') yields a valid JS string literal; embedding it and
  // re-parsing keeps args as data, never code. JSON.stringify can throw on a
  // value that slipped past safeSerialize (e.g. a BigInt) — caller guards.
  const argsJson = JSON.stringify(args ?? [])
  // `console[method]` (not `console.log`) preserves the original level so the
  // DevTools severity filter still works on the forwarded line.
  //
  // The trailing `//# sourceURL` stamps this injected line with a sentinel URL.
  // The service-console CDP capture (services/service-console) attached to THIS
  // service host would otherwise re-capture this `console[...]` call as a fresh
  // service entry and re-broadcast it to automation (duplicate). It skips any
  // `consoleAPICalled` whose top frame URL === RENDER_FORWARD_SOURCE_URL.
  return `(()=>{try{const a=JSON.parse(${JSON.stringify(argsJson)});console[${JSON.stringify(method)}]('[视图]',...a)}catch(_){}})()\n//# sourceURL=${RENDER_FORWARD_SOURCE_URL}`
}

export function createConsoleForwarder(
  bridge: Pick<BridgeRouterHandle, 'getServiceWc' | 'getServiceWcForBridge'>,
): ConsoleForwarder {
  const sinks = new Set<ConsoleSink>()
  const registry = new DisposableRegistry()

  /**
   * Render→service forward. Resolves the service host for the entry's owning
   * page (multi-app safe), falling back to the active app's service host when
   * the bridgeId is unknown — that's the host the embedded DevTools inspects.
   * No-op on a destroyed/missing host so we never write to a torn-down wc (pool
   * reuse / session swap can swap the host out under us).
   */
  function forwardRenderToServiceHost(entry: GuestConsoleEntry): void {
    let wc: WebContents | null = null
    if (entry.bridgeId && bridge.getServiceWcForBridge) {
      wc = bridge.getServiceWcForBridge(entry.bridgeId)
    }
    if (!wc) wc = bridge.getServiceWc()
    if (!wc || wc.isDestroyed()) return

    let script: string
    try {
      script = buildForwardScript(entry.level ?? 'log', entry.args ?? [])
    } catch {
      // Args that escaped safeSerialize and aren't JSON-stringifiable — drop
      // rather than break the forward. Console capture must never throw.
      return
    }
    // executeJavaScript rejects if the host navigates/teardowns mid-call; the
    // injected body is itself try/caught. Swallow either — best-effort mirror.
    wc.executeJavaScript(script, true).catch(() => {})
  }

  return {
    // The single sink bridge-router calls (`ctx.guestConsole.emit`). Fans out
    // to external subscribers (both layers) then runs the render→service forward
    // (render only — see loop-safety invariant in the module header).
    emit(raw) {
      const entry = (raw ?? {}) as GuestConsoleEntry
      for (const sink of sinks) {
        try { sink(entry) } catch { /* a sink must never break the others */ }
      }
      // Forward ONLY the render layer. Service entries are already shown
      // natively in the attached DevTools, and forwarding them would loop
      // (see header).
      if (entry.source === 'render') forwardRenderToServiceHost(entry)
    },
    subscribe(sink) {
      sinks.add(sink)
      return registry.add(toDisposable(() => { sinks.delete(sink) }))
    },
    dispose() {
      sinks.clear()
      return registry.disposeAll()
    },
  }
}
