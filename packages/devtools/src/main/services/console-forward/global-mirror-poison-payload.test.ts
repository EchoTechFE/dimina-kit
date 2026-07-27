/**
 * Adversarial-input tests for the two global mirrors
 * (`createGlobalConsoleMirror` / `createGlobalDiagnosticsMirror`).
 *
 * Both mirrors build an `executeJavaScript` script from untrusted payload
 * data (console args / diagnostic message) by round-tripping it through
 * `JSON.stringify` (console mirror) or a template-literal string coercion
 * (diagnostics mirror). A single poison entry (circular reference, BigInt,
 * pathologically deep nesting, a value that throws on stringification) must
 * only ever cost that ONE entry — it must never throw synchronously out of
 * the mirror, and it must never block delivery of entries that arrive after
 * it.
 *
 * This file is an independent adversarial test author's probe, written
 * against the CURRENT implementation without modifying it — see each test's
 * comment for whether the assertion held (a real defensive boundary) or
 * exposed an asymmetry between the two mirrors (documented, not fixed here).
 */
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { ConsoleForwarder, ConsoleSink, GuestConsoleEntry } from './index.js'
import type { Diagnostic, DiagnosticsBus } from '../diagnostics/index.js'
import { createGlobalConsoleMirror } from './global-console-mirror.js'
import { createGlobalDiagnosticsMirror } from './global-diagnostics-mirror.js'

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function makeWc(): { wc: WebContents, exec: ReturnType<typeof vi.fn> } {
  const exec = vi.fn(() => Promise.resolve(undefined))
  const wc = {
    isDestroyed: () => false,
    getURL: () => 'file:///main-window.html',
    isLoadingMainFrame: () => false,
    executeJavaScript: exec,
  } as unknown as WebContents
  return { wc, exec }
}

function makeFakeForwarder(): {
  forwarder: Pick<ConsoleForwarder, 'subscribe'>
  emit: (entry: GuestConsoleEntry) => void
} {
  const sinks = new Set<ConsoleSink>()
  const subscribe = vi.fn((sink: ConsoleSink) => {
    sinks.add(sink)
    return { dispose: () => { sinks.delete(sink) } }
  })
  return {
    forwarder: { subscribe },
    emit: (entry) => { for (const sink of [...sinks]) sink(entry) },
  }
}

function makeFakeDiagnosticsBus(): {
  bus: Pick<DiagnosticsBus, 'subscribe'>
  report: (d: Diagnostic) => void
} {
  const sinks = new Set<(d: Diagnostic) => void>()
  const subscribe = vi.fn((sink: (d: Diagnostic) => void) => {
    sinks.add(sink)
    return { dispose: () => { sinks.delete(sink) } }
  })
  return {
    bus: { subscribe },
    report: (d) => { for (const sink of [...sinks]) sink(d) },
  }
}

function makeHostChangedController(): {
  onHostChanged: (handler: (hostWc: WebContents | null) => void) => () => void
  fire: (hostWc: WebContents | null) => void
} {
  let handler: ((hostWc: WebContents | null) => void) | null = null
  return {
    onHostChanged: (h) => { handler = h; return () => { handler = null } },
    fire: (hostWc) => { handler?.(hostWc) },
  }
}

/** Build a self-referencing object — `JSON.stringify` throws on this. */
function makeCircular(): Record<string, unknown> {
  const obj: Record<string, unknown> = { tag: 'circular' }
  obj.self = obj
  return obj
}

/** Build nesting deep enough that `JSON.stringify`'s recursive descent blows
 *  the call stack (confirmed below, in the sanity-check test). */
function makeDeepNesting(depth: number): unknown[] {
  let node: unknown[] = []
  for (let i = 0; i < depth; i++) node = [node]
  return node
}


/** Test-harness broker: routes Runtime.evaluate straight back to the target
 * wc's own executeJavaScript spy (same arity, same promise semantics), so
 * every existing script-content / gating / retry assertion keeps observing
 * through `exec` unchanged while the mirror itself now talks CDP. */
const passthroughBroker = {
  acquire: (wc: WebContents) => ({
    send: (_method: string, params?: object) =>
      Promise.resolve((wc as unknown as { executeJavaScript: (s: string, g: boolean) => unknown })
        .executeJavaScript((params as { expression?: string } | undefined)?.expression ?? '', true)),
    onMessage: () => ({ dispose: () => {} }),
    onDetach: () => ({ dispose: () => {} }),
    ensureRenderDomains: () => Promise.resolve(),
    dispose: () => {},
  }),
  dispose: () => {},
} as unknown as import('../cdp-session/index.js').CdpSessionBroker

describe('sanity: the poison payloads actually poison JSON.stringify', () => {
  it('circular reference throws', () => {
    expect(() => JSON.stringify(makeCircular())).toThrow(/circular/i)
  })
  it('BigInt throws', () => {
    expect(() => JSON.stringify([10n])).toThrow(/BigInt/i)
  })
  it('extreme nesting throws (stack overflow)', () => {
    expect(() => JSON.stringify(makeDeepNesting(200_000))).toThrow()
  })
})

describe('createGlobalConsoleMirror — one poison console entry never blocks the next', () => {
  it('a circular-reference arg is dropped (no throw out of the mirror) and a subsequent normal entry still gets injected', async () => {
    const { forwarder, emit } = makeFakeForwarder()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()
    createGlobalConsoleMirror(forwarder, target, onHostChanged, { broker: passthroughBroker })
    fire(host)

    expect(() => emit({ source: 'service', level: 'log', args: [makeCircular()] })).not.toThrow()
    await flushMicrotasks()
    expect(exec, 'the poisoned entry must not have reached executeJavaScript').not.toHaveBeenCalled()

    emit({ source: 'service', level: 'log', args: ['after poison'] })
    await flushMicrotasks()
    expect(exec, 'a normal entry AFTER the poisoned one must still be delivered').toHaveBeenCalledTimes(1)
    expect(String(exec.mock.calls[0]![0])).toContain(JSON.stringify(JSON.stringify(['after poison'])))
  })

  it('a BigInt arg is dropped, and does not poison the mirror for later entries', async () => {
    const { forwarder, emit } = makeFakeForwarder()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()
    createGlobalConsoleMirror(forwarder, target, onHostChanged, { broker: passthroughBroker })
    fire(host)

    expect(() => emit({ source: 'service', level: 'log', args: [10n] })).not.toThrow()
    await flushMicrotasks()
    expect(exec).not.toHaveBeenCalled()

    emit({ source: 'render', level: 'warn', args: ['still alive'] })
    await flushMicrotasks()
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('a pathologically deep-nested arg (stack-overflow on stringify) is dropped without crashing the process, and later entries still flow', async () => {
    const { forwarder, emit } = makeFakeForwarder()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()
    createGlobalConsoleMirror(forwarder, target, onHostChanged, { broker: passthroughBroker })
    fire(host)

    expect(() => emit({ source: 'service', level: 'error', args: [makeDeepNesting(200_000)] })).not.toThrow()
    await flushMicrotasks()
    expect(exec).not.toHaveBeenCalled()

    emit({ source: 'service', level: 'error', args: ['survived the stack overflow'] })
    await flushMicrotasks()
    expect(exec).toHaveBeenCalledTimes(1)
  })
})

describe('createGlobalDiagnosticsMirror — malformed diagnostic fields', () => {
  it('message undefined at runtime (type violation) still injects a script — template coercion, not JSON.stringify, handles it', async () => {
    const { bus, report } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()
    createGlobalDiagnosticsMirror(bus, target, onHostChanged, { broker: passthroughBroker })
    fire(host)

    const malformed = { severity: 'error', code: 'x', message: undefined, ts: Date.now() } as unknown as Diagnostic
    expect(() => report(malformed)).not.toThrow()
    await flushMicrotasks()

    expect(exec).toHaveBeenCalledTimes(1)
    expect(String(exec.mock.calls[0]![0])).toContain('undefined')
  })

  it('severity of an invalid runtime type (number, not one of error/warn/info) still builds and dispatches a script rather than throwing', async () => {
    const { bus, report } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()
    createGlobalDiagnosticsMirror(bus, target, onHostChanged, { broker: passthroughBroker })
    fire(host)

    const malformed = { severity: 42, code: 'x', message: 'hi', ts: Date.now() } as unknown as Diagnostic
    expect(() => report(malformed)).not.toThrow()
    await flushMicrotasks()

    // DIAGNOSTIC_CONSOLE_CALL[42] is undefined, so the generated script calls
    // the literal identifier `undefined` as a function — a runtime TypeError
    // INSIDE the injected IIFE's own try/catch, not something Node sees.
    expect(exec).toHaveBeenCalledTimes(1)
  })

  /**
   * `createGlobalConsoleMirror`'s `inject()` wraps its `buildMirrorScript()`
   * call in `try { } catch { return false }` (see global-console-mirror.ts).
   * `createGlobalDiagnosticsMirror`'s `inject()` does NOT — it calls
   * `buildMirrorScript(d.severity, d.message)` directly inline inside the
   * `target.executeJavaScript(...)` argument position, unguarded. A `message`
   * that throws on the `${message}` template-literal coercion (e.g. a Symbol
   * — a real runtime possibility if an upstream `Diagnostic.message` is ever
   * populated from a non-string source) makes `buildMirrorScript` itself
   * throw SYNCHRONOUSLY out of `inject()`. This is a structural asymmetry
   * between the two sibling mirrors.
   *
   * It is NOT a crash in practice only because `inject()`'s sole caller,
   * `createOpenGatedRelay`'s `deliver()` (open-gated-relay.ts), invokes it as
   * `Promise.resolve().then(() => inject(entry))` — a synchronous throw
   * inside a `.then()` callback becomes a rejected promise, which
   * `deliver()`'s second `.then(..., () => state.delete(entry))` handler
   * already catches. So the outer relay's own defensive wrapping is what
   * saves this, not `global-diagnostics-mirror.ts` itself.
   */
  it('a message that throws on string coercion (Symbol) throws synchronously out of inject(), but the surrounding relay swallows it and later diagnostics still flow', async () => {
    const { bus, report } = makeFakeDiagnosticsBus()
    const { onHostChanged, fire } = makeHostChangedController()
    const { wc: target, exec } = makeWc()
    const { wc: host } = makeWc()
    createGlobalDiagnosticsMirror(bus, target, onHostChanged, { broker: passthroughBroker })
    fire(host)

    const poisoned = { severity: 'warn', code: 'x', message: Symbol('poison'), ts: Date.now() } as unknown as Diagnostic
    // report() itself is synchronous fan-out to sinks; deliver() is what
    // wraps inject() in a promise, so THIS call must not throw either.
    expect(() => report(poisoned)).not.toThrow()
    await flushMicrotasks()
    expect(exec, 'the poisoned diagnostic must not have reached executeJavaScript').not.toHaveBeenCalled()

    report({ severity: 'info', code: 'y', message: 'after poison', ts: Date.now() } as Diagnostic)
    await flushMicrotasks()
    expect(exec, 'a normal diagnostic AFTER the poisoned one must still be delivered').toHaveBeenCalledTimes(1)
  })
})
