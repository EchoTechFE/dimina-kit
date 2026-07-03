/**
 * Behavior tests for the authoritative diagnostics bus (`createDiagnosticsBus`).
 *
 * Main-process diagnostics (page-not-found, logic-bundle-unreachable,
 * app-config-unreachable, service-host-error, service-uncaught-error, …) must
 * all funnel through ONE bus so every consumer (future Console-panel injection,
 * automation, main-process logs) sees the same set of events with a stable
 * shape. This file guards that single entry point's contract in isolation, with
 * no dependency on bridge-router or console-forward:
 *
 *   - `report()` stamps `ts` and dispatches synchronously to live subscribers.
 *   - A ring buffer replays history to a NEW subscriber (default on), bounded by
 *     `bufferCap` (default 200) so an unbounded backlog can never accumulate
 *     while nothing is listening yet (e.g. before the Console panel attaches).
 *   - `report()` always mirrors to the main-process console — the bus must
 *     never depend on a downstream subscriber existing to be diagnosable from
 *     the terminal.
 *   - A throwing sink must never break delivery to sibling sinks.
 *   - `dispose()` is a hard stop: no further dispatch, no lingering
 *     subscriptions.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createDiagnosticsBus, type Diagnostic } from './index.js'

describe('createDiagnosticsBus — report + live dispatch', () => {
  it('stamps `ts` on the dispatched entry and delivers it synchronously to a live subscriber', () => {
    const bus = createDiagnosticsBus()
    const received: Diagnostic[] = []
    bus.subscribe((d) => { received.push(d) })

    const before = Date.now()
    bus.report({ severity: 'error', code: 'page-not-found', message: 'Page[pages/x/x] not found' })
    const after = Date.now()

    expect(received).toHaveLength(1)
    expect(received[0]?.severity).toBe('error')
    expect(received[0]?.code).toBe('page-not-found')
    expect(received[0]?.message).toBe('Page[pages/x/x] not found')
    expect(typeof received[0]?.ts).toBe('number')
    expect(received[0]!.ts).toBeGreaterThanOrEqual(before)
    expect(received[0]!.ts).toBeLessThanOrEqual(after)
  })

  it('carries an optional appSessionId through untouched, and leaves it undefined when omitted', () => {
    const bus = createDiagnosticsBus()
    const received: Diagnostic[] = []
    bus.subscribe((d) => { received.push(d) })

    bus.report({ severity: 'warn', code: 'x', message: 'scoped', appSessionId: 'session-1' })
    bus.report({ severity: 'warn', code: 'y', message: 'global' })

    expect(received[0]?.appSessionId).toBe('session-1')
    expect(received[1]?.appSessionId).toBeUndefined()
  })

  it('fans one report out to every subscribed sink', () => {
    const bus = createDiagnosticsBus()
    const a: Diagnostic[] = []
    const b: Diagnostic[] = []
    bus.subscribe((d) => { a.push(d) })
    bus.subscribe((d) => { b.push(d) })

    bus.report({ severity: 'info', code: 'info-code', message: 'hello' })

    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })

  it('stops delivering to a subscriber after its handle is disposed', () => {
    const bus = createDiagnosticsBus()
    const received: Diagnostic[] = []
    const sub = bus.subscribe((d) => { received.push(d) })

    bus.report({ severity: 'info', code: 'a', message: 'one' })
    sub.dispose()
    bus.report({ severity: 'info', code: 'b', message: 'two' })

    expect(received).toHaveLength(1)
    expect(received[0]?.code).toBe('a')
  })
})

describe('createDiagnosticsBus — replay buffer', () => {
  it('replays prior entries in order to a subscriber by default (replay defaults true)', () => {
    const bus = createDiagnosticsBus()
    bus.report({ severity: 'error', code: 'first', message: 'm1' })
    bus.report({ severity: 'warn', code: 'second', message: 'm2' })

    const received: Diagnostic[] = []
    bus.subscribe((d) => { received.push(d) })

    expect(received.map(d => d.code)).toEqual(['first', 'second'])
  })

  it('delivers replayed history before any subsequent live report', () => {
    const bus = createDiagnosticsBus()
    bus.report({ severity: 'error', code: 'history', message: 'm1' })

    const received: Diagnostic[] = []
    bus.subscribe((d) => { received.push(d) })
    bus.report({ severity: 'error', code: 'live', message: 'm2' })

    expect(received.map(d => d.code)).toEqual(['history', 'live'])
  })

  it('replay:false gets ONLY live reports, skipping all history', () => {
    const bus = createDiagnosticsBus()
    bus.report({ severity: 'error', code: 'history', message: 'm1' })

    const received: Diagnostic[] = []
    bus.subscribe((d) => { received.push(d) }, { replay: false })
    bus.report({ severity: 'error', code: 'live', message: 'm2' })

    expect(received.map(d => d.code)).toEqual(['live'])
  })

  it('drops the oldest entries once bufferCap is exceeded (ring buffer), keeping only the most recent', () => {
    const bus = createDiagnosticsBus({ bufferCap: 3 })
    for (let i = 0; i < 5; i++) {
      bus.report({ severity: 'info', code: `c${i}`, message: `m${i}` })
    }

    const received: Diagnostic[] = []
    bus.subscribe((d) => { received.push(d) })

    // Only the last 3 of 5 reports survive the cap; the oldest 2 (c0, c1) are gone.
    expect(received.map(d => d.code)).toEqual(['c2', 'c3', 'c4'])
  })

  it('defaults bufferCap to 200: the 201st report evicts the very first one from replay', () => {
    const bus = createDiagnosticsBus()
    for (let i = 0; i < 201; i++) {
      bus.report({ severity: 'info', code: `c${i}`, message: `m${i}` })
    }

    const received: Diagnostic[] = []
    bus.subscribe((d) => { received.push(d) })

    expect(received).toHaveLength(200)
    expect(received[0]?.code).toBe('c1')
    expect(received[received.length - 1]?.code).toBe('c200')
  })
})

describe('createDiagnosticsBus — sink isolation', () => {
  it('a throwing sink does not prevent delivery to other subscribed sinks', () => {
    const bus = createDiagnosticsBus()
    const good: Diagnostic[] = []
    bus.subscribe(() => { throw new Error('sink boom') })
    bus.subscribe((d) => { good.push(d) })

    expect(() => {
      bus.report({ severity: 'error', code: 'x', message: 'm' })
    }).not.toThrow()
    expect(good).toHaveLength(1)
  })
})

describe('createDiagnosticsBus — console mirroring', () => {
  let errorSpy: MockInstance<typeof console.error>
  let warnSpy: MockInstance<typeof console.warn>
  let infoSpy: MockInstance<typeof console.info>

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
    warnSpy.mockRestore()
    infoSpy.mockRestore()
  })

  it('mirrors a severity:"error" report to console.error, with code and message present in the output', () => {
    const bus = createDiagnosticsBus()
    bus.report({ severity: 'error', code: 'page-not-found', message: 'Page[pages/x/x] not found' })

    expect(errorSpy).toHaveBeenCalledTimes(1)
    const out = errorSpy.mock.calls[0]!.map(String).join(' ')
    expect(out).toContain('page-not-found')
    expect(out).toContain('Page[pages/x/x] not found')
    expect(warnSpy).not.toHaveBeenCalled()
    expect(infoSpy).not.toHaveBeenCalled()
  })

  it('mirrors a severity:"warn" report to console.warn only', () => {
    const bus = createDiagnosticsBus()
    bus.report({ severity: 'warn', code: 'warn-code', message: 'careful' })

    expect(warnSpy).toHaveBeenCalledTimes(1)
    const out = warnSpy.mock.calls[0]!.map(String).join(' ')
    expect(out).toContain('warn-code')
    expect(out).toContain('careful')
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('mirrors a severity:"info" report to console.info only', () => {
    const bus = createDiagnosticsBus()
    bus.report({ severity: 'info', code: 'info-code', message: 'fyi' })

    expect(infoSpy).toHaveBeenCalledTimes(1)
    const out = infoSpy.mock.calls[0]!.map(String).join(' ')
    expect(out).toContain('info-code')
    expect(out).toContain('fyi')
    expect(errorSpy).not.toHaveBeenCalled()
  })
})

describe('createDiagnosticsBus — dispose', () => {
  it('stops dispatching to previously-subscribed sinks after dispose', () => {
    const bus = createDiagnosticsBus()
    const received: Diagnostic[] = []
    bus.subscribe((d) => { received.push(d) })

    bus.dispose()
    bus.report({ severity: 'error', code: 'after-dispose', message: 'should not arrive' })

    expect(received).toHaveLength(0)
  })

  it('does not throw when report() is called after dispose (fail-quiet, not fail-loud)', () => {
    const bus = createDiagnosticsBus()
    bus.dispose()
    expect(() => {
      bus.report({ severity: 'error', code: 'x', message: 'm' })
    }).not.toThrow()
  })
})
