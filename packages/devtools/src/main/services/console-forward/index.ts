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
 *      rebroadcasts every entry as an `App.logAdded` event). Subscribers register
 *      here rather than each setting `ctx.guestConsole` directly (which would
 *      clobber one another), so render + service both reach every consumer.
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
 *
 * ── Diagnostics injection (optional 2nd constructor arg) ────────────────────
 * When a `DiagnosticsBus` is supplied, this forwarder ALSO subscribes to it
 * (`replay:true`, so entries buffered before construction are delivered too)
 * and injects every diagnostic into the OWNING session's service-host console —
 * main-synthesized diagnostics (page-not-found, logic-bundle-unreachable, …)
 * otherwise never reach a real `console.*` call the CDP capture could observe.
 * Reuses the SAME `RENDER_FORWARD_SOURCE_URL` sentinel as the render mirror, so
 * this injection is exempt from the same loop-safety skip. A diagnostic that
 * arrives before its session's service host is resolvable (or while it is
 * destroyed) queues by `appSessionId` (or in a global bucket when the
 * diagnostic carries none); `notifyServiceHostReady(appSessionId)` flushes that
 * session's bucket plus the global bucket into its now-ready wc, then clears
 * both — so a repeat notify never re-injects.
 */
import type { WebContents } from 'electron'
import { DisposableRegistry, toDisposable, type Disposable } from '@dimina-kit/electron-deck/main'
import type { BridgeRouterHandle } from '../../ipc/bridge-router.js'
import { RENDER_FORWARD_SOURCE_URL } from '../service-console/console-api.js'
import type { Diagnostic, DiagnosticsBus } from '../diagnostics/index.js'
import { isInternalLogMessage } from './internal-log.js'

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
   *
   * A bounded history buffer (200 entries, oldest dropped first — mirrors
   * `DiagnosticsBus`'s `DEFAULT_BUFFER_CAP` ring-buffer style) records every
   * entry regardless of whether anyone is subscribed. `opts.replay` (default
   * `false`, UNLIKE `DiagnosticsBus` whose default is `true`) opts a new
   * subscriber into draining that buffer, in order, before receiving live
   * entries. Default stays non-replaying because the existing automation
   * subscriber (`services/automation/index.ts`) wants only entries from the
   * moment it subscribes — a history dump on an existing WS connection would
   * be a surprise duplicate broadcast. `{replay:true}` exists for the global
   * console mirror, whose whole point is to catch up a standalone debug
   * window opened well after boot.
   */
  subscribe(sink: ConsoleSink, opts?: { replay?: boolean }): Disposable
  /**
   * Flush any diagnostic queued for `appSessionId` (plus the global,
   * session-less queue) into that session's now-ready service-host wc.
   * Idempotent: entries are removed from their bucket as they flush, so a
   * repeat call for the same session injects nothing further. Call once the
   * session's service-host webContents has actually navigated/loaded (e.g.
   * from `bootServiceHost`, after `did-finish-load`) — calling it earlier just
   * finds nothing resolvable and leaves the queue intact for a later call.
   */
  notifyServiceHostReady(appSessionId: string): void
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

/** `Diagnostic.severity` → the literal `console.<method>` call to emit (dot form, not computed — kept greppable/CDP-attributable like a hand-written call site). */
const DIAGNOSTIC_CONSOLE_CALL: Record<Diagnostic['severity'], string> = {
  error: 'console.error',
  warn: 'console.warn',
  info: 'console.info',
}

/**
 * Build the `executeJavaScript` source that injects one diagnostic into the
 * service host's console, prefixed `[dimina-kit]`. Args ride as a JSON string
 * (same anti-injection shape as `buildForwardScript`) and the sourceURL is the
 * SAME sentinel the render mirror uses, so this line is exempt from
 * service-console's loop-safety skip too.
 */
function buildDiagnosticScript(severity: Diagnostic['severity'], message: string): string {
  const call = DIAGNOSTIC_CONSOLE_CALL[severity]
  const argsJson = JSON.stringify([`[dimina-kit] ${message}`])
  return `(()=>{try{const a=JSON.parse(${JSON.stringify(argsJson)});${call}(...a)}catch(_){}})()\n//# sourceURL=${RENDER_FORWARD_SOURCE_URL}`
}

export function createConsoleForwarder(
  bridge: Pick<BridgeRouterHandle, 'getServiceWc' | 'getServiceWcForBridge'>,
  diagnostics?: DiagnosticsBus,
): ConsoleForwarder {
  const sinks = new Set<ConsoleSink>()
  const registry = new DisposableRegistry()
  // Bounded history ring buffer backing `subscribe(sink, {replay:true})` —
  // see the interface doc comment above. Every entry is recorded regardless
  // of whether anyone is subscribed, so a replaying subscriber that arrives
  // long after boot (the standalone global debug window) still catches up.
  const CONSOLE_BUFFER_CAP = 200
  const buffer: GuestConsoleEntry[] = []
  // Diagnostics queued because no live service-host wc could be resolved yet,
  // bucketed by the owning appSessionId; diagnostics with no appSessionId land
  // in `pendingGlobal` instead. `notifyServiceHostReady` drains both into the
  // session that just became ready.
  const pendingBySession = new Map<string, Diagnostic[]>()
  const pendingGlobal: Diagnostic[] = []
  // Sessions whose service host has finished loading service.html (the caller
  // signals this via `notifyServiceHostReady`). A resolvable wc alone is NOT
  // readiness: the window exists (and is bound) before its spawn navigation
  // lands, and anything injected into that pre-load document is wiped by the
  // navigation — the diagnostic would silently vanish from the Console panel.
  const readySessions = new Set<string>()

  function injectDiagnostic(wc: WebContents, d: Diagnostic): void {
    wc.executeJavaScript(buildDiagnosticScript(d.severity, d.message), true).catch(() => {})
  }

  /**
   * Inject a diagnostic into its owning session's service-host console, or
   * queue it until that host is READY (not merely constructed — see
   * `readySessions`). Ownership is strict: a session-owned diagnostic NEVER
   * falls back to the currently-active host — while `handleSpawn` is still
   * running, the new session's host doesn't exist yet and the "active" host
   * is the OUTGOING session's window, so a fallback would land the message in
   * a console about to be destroyed instead of the session it explains. Only
   * session-less diagnostics may use the active host. Never throws — a
   * missing/destroyed/not-yet-ready host is a normal state, not an error.
   */
  function handleDiagnostic(d: Diagnostic): void {
    // Internal-audience diagnostics (e.g. compile-standby's warm-pool
    // lifecycle) are devtools-tooling-only state — never inject them into a
    // project's service host (the right-panel CDP is natively attached
    // there), and never queue them either: queuing exists so a diagnostic
    // survives until ITS session's host becomes resolvable, which is
    // meaningless for something that must never reach any service host.
    // (See global-diagnostics-mirror.ts for where these actually surface —
    // the independent, unfiltered "debug the whole app" panel.)
    if (d.audience === 'internal') return
    if (d.appSessionId) {
      const wc = readySessions.has(d.appSessionId) && bridge.getServiceWcForBridge
        ? bridge.getServiceWcForBridge(d.appSessionId)
        : null
      if (wc && !wc.isDestroyed()) {
        injectDiagnostic(wc, d)
        return
      }
      const bucket = pendingBySession.get(d.appSessionId)
      if (bucket) bucket.push(d)
      else pendingBySession.set(d.appSessionId, [d])
      return
    }
    const wc = bridge.getServiceWc()
    if (wc && !wc.isDestroyed()) {
      injectDiagnostic(wc, d)
      return
    }
    pendingGlobal.push(d)
  }

  if (diagnostics) {
    // replay:true so diagnostics reported before this forwarder existed (early
    // boot, buffered on the bus) are queued/injected here too.
    registry.add(diagnostics.subscribe(handleDiagnostic, { replay: true }))
  }

  /**
   * Render→service forward. Resolves the service host for the entry's owning
   * page (multi-app safe), falling back to the active app's service host when
   * the bridgeId is unknown — that's the host the embedded DevTools inspects.
   * No-op on a destroyed/missing host so we never write to a torn-down wc (pool
   * reuse / session swap can swap the host out under us). Skips dimina
   * framework-internal render-layer log lines (`isInternalLogMessage`) —
   * those must never reach the project's right-panel console at all (the
   * global console mirror still sees them via the `sinks` broadcast in
   * `emit()`, which runs before this function). This is the source-level fix
   * for the render half of the noise console-filter.ts's front-end text
   * filter used to paper over; the service-layer half (`[service]` lines,
   * native CDP-observed, no interception point available — see
   * service-host/preload.cjs's "console.* is deliberately NOT patched"
   * comment) still needs that filter.
   */
  function forwardRenderToServiceHost(entry: GuestConsoleEntry): void {
    if (isInternalLogMessage(entry)) return
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
      buffer.push(entry)
      if (buffer.length > CONSOLE_BUFFER_CAP) buffer.shift()
      for (const sink of sinks) {
        try { sink(entry) } catch { /* a sink must never break the others */ }
      }
      // Forward ONLY the render layer. Service entries are already shown
      // natively in the attached DevTools, and forwarding them would loop
      // (see header).
      if (entry.source === 'render') forwardRenderToServiceHost(entry)
    },
    subscribe(sink, opts) {
      if (opts?.replay) {
        for (const entry of buffer) {
          try { sink(entry) } catch { /* isolate a replay throw same as a live one */ }
        }
      }
      sinks.add(sink)
      return registry.add(toDisposable(() => { sinks.delete(sink) }))
    },
    notifyServiceHostReady(appSessionId) {
      // Readiness is sticky per session: from here on, session-owned
      // diagnostics inject directly instead of queueing.
      readySessions.add(appSessionId)
      // Re-resolve fresh rather than trusting whatever `handleDiagnostic` saw at
      // report time — the caller invokes this exactly when it knows the wc just
      // became live, so that resolution wins even if an earlier snapshot was
      // destroyed/missing.
      const wc = bridge.getServiceWcForBridge ? bridge.getServiceWcForBridge(appSessionId) : null
      if (!wc) return
      const sessionEntries = pendingBySession.get(appSessionId)
      if (sessionEntries) {
        for (const d of sessionEntries) injectDiagnostic(wc, d)
        pendingBySession.delete(appSessionId)
      }
      if (pendingGlobal.length) {
        for (const d of pendingGlobal) injectDiagnostic(wc, d)
        pendingGlobal.length = 0
      }
    },
    dispose() {
      sinks.clear()
      buffer.length = 0
      pendingBySession.clear()
      pendingGlobal.length = 0
      readySessions.clear()
      return registry.disposeAll()
    },
  }
}
