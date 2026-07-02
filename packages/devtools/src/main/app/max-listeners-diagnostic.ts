/**
 * Runtime diagnostic for `MaxListenersExceededWarning`.
 *
 * Node prints `MaxListenersExceededWarning: N <event> listeners added to
 * [emitter]` when an EventEmitter crosses its (default 10) ceiling, but the
 * message alone does not identify WHICH Electron WebContents tripped it. This
 * hook decodes the warning's `emitter` (present on the warning object in current
 * Node) into the wc's id / type / url so a stray listener accrual can be pinned
 * to a concrete surface (DevTools host, service host, main window, …) instead of
 * guessed at. Dev-only; a no-op counterpart is returned when disabled.
 */

/** Shape of Node's `MaxListenersExceededWarning` (its extra fields are untyped). */
interface MaxListenersWarning extends Error {
  emitter?: unknown
  type?: string
  count?: number
}

/** A subset of the Electron WebContents surface the decoder probes reflectively. */
interface WebContentsLike {
  id?: number
  getType?: () => string
  getURL?: () => string
  isDestroyed?: () => boolean
}

export interface MaxListenersWarningReport {
  event: string | undefined
  count: number | undefined
  wcId: number | undefined
  wcType: string | undefined
  url: string | undefined
  destroyed: boolean | undefined
  stack: string | undefined
}

// Run a probe thunk, swallowing anything it throws. The method call lives INSIDE
// the thunk (not eagerly bound at the call site) so a malformed emitter whose
// `getType`/`getURL`/`isDestroyed` is a non-function value throws here and is
// caught, rather than blowing up while evaluating the argument.
function callSafe<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

/**
 * Decode a warning into a flat report, or `null` if it is not a
 * `MaxListenersExceededWarning`. Pure — no logging, no process state.
 */
export function describeMaxListenersWarning(warning: Error): MaxListenersWarningReport | null {
  if (warning.name !== 'MaxListenersExceededWarning') return null
  const w = warning as MaxListenersWarning
  const emitter = (w.emitter ?? undefined) as WebContentsLike | undefined
  return {
    event: w.type,
    count: w.count,
    wcId: typeof emitter?.id === 'number' ? emitter.id : undefined,
    wcType: callSafe(() => emitter?.getType?.()),
    url: callSafe(() => emitter?.getURL?.()),
    destroyed: callSafe(() => emitter?.isDestroyed?.()),
    stack: warning.stack,
  }
}

/**
 * Register a `process.on('warning')` listener that logs a decoded report for any
 * `MaxListenersExceededWarning`. Returns a disposer that removes the listener.
 * Other warning kinds pass through untouched.
 */
export function installMaxListenersWarningDiagnostic(
  log: (report: MaxListenersWarningReport) => void = (r) =>
    console.warn('[max-listeners]', r),
): () => void {
  const onWarning = (warning: Error): void => {
    const report = describeMaxListenersWarning(warning)
    if (report) log(report)
  }
  process.on('warning', onWarning)
  return () => {
    process.removeListener('warning', onWarning)
  }
}
