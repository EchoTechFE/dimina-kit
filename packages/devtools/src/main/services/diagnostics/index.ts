/**
 * Diagnostics bus: the single authoritative channel for developer-facing
 * diagnostics synthesized by main (e.g. "page not found", "logic bundle
 * unreachable") that do not originate from a real `console.*` call the
 * embedded service-host DevTools' CDP capture could observe on its own.
 *
 * Main-synthesized diagnostics used to reach only `ctx.guestConsole.emit`,
 * which fans out to automation subscribers but — for `source:'service'`
 * entries — is never injected into the service host's own console (see
 * `console-forward`'s render-only forward invariant), so they never appeared
 * in the Console panel. This bus is the fix: `report()` is the one place a
 * diagnostic is born, and `console-forward` subscribes to inject each one
 * into the owning session's service-host console (queuing until that
 * session's window is ready — see `notifyServiceHostReady`).
 */
export type DiagnosticSeverity = 'error' | 'warn' | 'info'

export interface Diagnostic {
  severity: DiagnosticSeverity
  code: string
  message: string
  appSessionId?: string
  ts: number
  /**
   * Who this diagnostic is for. `'internal'` means devtools-tooling-only
   * state (e.g. compile-standby's warm-pool lifecycle) that must never reach
   * the per-project service-host console the right-panel CDP is attached to
   * — see `console-forward/index.ts`'s `handleDiagnostic` gate. `'user'` or
   * omitted means the existing behavior: a real diagnostic about the
   * inspected mini-program, injected into that project's Console panel.
   */
  audience?: 'user' | 'internal'
}

export interface DiagnosticsBus {
  /** Record one diagnostic: buffers it, mirrors it to the main-process console, and synchronously notifies every live subscriber. No-op after `dispose()`. */
  report(d: { severity: DiagnosticSeverity; code: string; message: string; appSessionId?: string; audience?: 'user' | 'internal' }): void
  /**
   * Register a sink. With `replay` (default true) the sink is first called,
   * in order, for every buffered diagnostic still held, then for every
   * diagnostic reported from now on; `replay: false` skips the backlog and
   * only delivers diagnostics reported after this call.
   */
  subscribe(sink: (d: Diagnostic) => void, opts?: { replay?: boolean }): { dispose(): void }
  /** Clears subscribers and the buffer. `report()` becomes a no-op afterward (including the console mirror — dispose means fully off, not "log-only"). */
  dispose(): void
}

const DEFAULT_BUFFER_CAP = 200

const CONSOLE_METHOD: Record<DiagnosticSeverity, 'error' | 'warn' | 'info'> = {
  error: 'error',
  warn: 'warn',
  info: 'info',
}

export function createDiagnosticsBus(opts?: { bufferCap?: number }): DiagnosticsBus {
  const bufferCap = opts?.bufferCap && opts.bufferCap > 0 ? opts.bufferCap : DEFAULT_BUFFER_CAP
  const buffer: Diagnostic[] = []
  const sinks = new Set<(d: Diagnostic) => void>()
  let disposed = false

  return {
    report(d) {
      if (disposed) return
      const entry: Diagnostic = { ...d, ts: Date.now() }
      buffer.push(entry)
      // Ring buffer: drop the oldest once over cap. Bounded at `bufferCap` so a
      // burst of synthesized diagnostics can never grow this without limit.
      if (buffer.length > bufferCap) buffer.shift()
      // The one guaranteed-visible sink: unlike Console-panel injection (which
      // needs a live, ready service-host wc), the main-process terminal is
      // always there.
      console[CONSOLE_METHOD[entry.severity]](`[dimina-kit:${entry.code}] ${entry.message}`)
      for (const sink of sinks) {
        try { sink(entry) } catch { /* a sink must never break the others */ }
      }
    },
    subscribe(sink, subOpts) {
      const replay = subOpts?.replay ?? true
      if (replay) {
        for (const entry of buffer) {
          try { sink(entry) } catch { /* isolate a replay throw same as a live one */ }
        }
      }
      sinks.add(sink)
      let released = false
      return {
        dispose() {
          if (released) return
          released = true
          sinks.delete(sink)
        },
      }
    },
    dispose() {
      disposed = true
      sinks.clear()
      buffer.length = 0
    },
  }
}
