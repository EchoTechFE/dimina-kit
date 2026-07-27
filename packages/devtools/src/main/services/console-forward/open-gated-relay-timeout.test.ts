/**
 * Behavior tests for `createOpenGatedRelay`'s 4th (optional) parameter,
 * `opts?: { injectTimeoutMs?: number }` (default 10000) — the fix for a
 * production incident where `inject()` (an `executeJavaScript` call against a
 * `mainWindow.webContents` that is ALSO the DevTools-inspected side of a
 * `setDevToolsWebContents` relationship) hangs forever: Chromium never
 * settles that `executeJavaScript` promise while an external CDP client is
 * simultaneously attached, so the entry's `state` gets stuck at `'pending'`
 * permanently and is never retried, even though `inject()` never actually
 * confirmed success.
 *
 * A per-attempt timeout bounds how long an in-flight `inject()` call may hold
 * an entry `'pending'`: once `injectTimeoutMs` elapses without that attempt's
 * promise settling, the entry becomes eligible for a real retry again (the
 * next replay re-invokes `inject()` for it), instead of being black-holed
 * exactly like `open-gated-relay.test.ts`'s existing "sync inject() returning
 * false" scenario already guards against.
 *
 * A timed-out attempt's promise is not thrown away — it may still resolve or
 * reject LATE, after a newer attempt (started by a later replay) is already
 * in flight for the same entry. Each attempt therefore carries its own
 * generation stamp; only the attempt whose generation matches the entry's
 * CURRENT generation may act on settling (mark done / clear to retryable). A
 * stale settlement is a silent no-op — it must neither mark the entry done
 * behind the current attempt's back, nor disturb the current attempt's own
 * pending status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOpenGatedRelay } from './open-gated-relay.js'

interface FakeEntry {
  tag: string
}

function makeHostChangedController(): {
  onHostChanged: (handler: (hostWc: string | null) => void) => () => void
  fire: (hostWc: string | null) => void
} {
  let handler: ((hostWc: string | null) => void) | null = null
  const unregisterSpy = vi.fn()
  const registerSpy = vi.fn((h: (hostWc: string | null) => void) => {
    handler = h
    return unregisterSpy
  })
  return {
    onHostChanged: registerSpy,
    fire: (hostWc) => {
      if (!handler) throw new Error('onHostChanged handler was never registered')
      handler(hostWc)
    },
  }
}

/** Same buffer+replay fake contract as `open-gated-relay.test.ts`'s. */
function makeFakeSource(): {
  subscribe: (sink: (entry: FakeEntry) => void, opts: { replay: true }) => { dispose: () => void }
  emit: (entry: FakeEntry) => void
} {
  const buffer: FakeEntry[] = []
  const sinks = new Set<(entry: FakeEntry) => void>()
  const subscribe = vi.fn((sink: (entry: FakeEntry) => void, opts: { replay: true }) => {
    if (opts.replay) {
      for (const entry of buffer) sink(entry)
    }
    sinks.add(sink)
    let released = false
    return { dispose: () => { if (released) return; released = true; sinks.delete(sink) } }
  })
  return {
    subscribe,
    emit: (entry) => {
      buffer.push(entry)
      for (const sink of [...sinks]) sink(entry)
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createOpenGatedRelay — injectTimeoutMs bounds a hung inject() attempt', () => {
  it('an inject() promise that never settles frees the entry for retry once injectTimeoutMs elapses', async () => {
    const { subscribe, emit } = makeFakeSource()
    const { onHostChanged, fire } = makeHostChangedController()
    const entry = { tag: 'hangs-forever' }
    const inject = vi.fn((_entry: FakeEntry) => new Promise<boolean>(() => { /* never settles */ }))

    emit(entry)
    createOpenGatedRelay(onHostChanged, subscribe, inject, { injectTimeoutMs: 5000 })
    fire('host')
    await vi.advanceTimersByTimeAsync(0)

    expect(inject).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5000)

    // The next reopen must re-invoke inject() for the same entry — the timed
    // out attempt no longer keeps it permanently 'pending'.
    fire(null)
    fire('host')
    await vi.advanceTimersByTimeAsync(0)

    expect(inject).toHaveBeenCalledTimes(2)
    expect(inject.mock.calls[1]?.[0]).toBe(entry)
  })

  it('a late resolve(true) from a timed-out attempt does not mark the entry done and does not disturb a newer pending attempt for the same entry (generation-stamped settlement)', async () => {
    const { subscribe, emit } = makeFakeSource()
    const { onHostChanged, fire } = makeHostChangedController()
    const entry = { tag: 'stale-then-fresh' }
    let resolveFirstAttempt: ((ok: boolean) => void) | undefined
    let resolveSecondAttempt: ((ok: boolean) => void) | undefined
    const inject = vi.fn()
    inject.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveFirstAttempt = resolve }))
    inject.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveSecondAttempt = resolve }))

    emit(entry)
    createOpenGatedRelay(onHostChanged, subscribe, inject, { injectTimeoutMs: 5000 })

    // Attempt #1 starts and hangs.
    fire('host')
    await vi.advanceTimersByTimeAsync(0)
    expect(inject).toHaveBeenCalledTimes(1)

    // It times out — the entry becomes retryable.
    await vi.advanceTimersByTimeAsync(5000)

    // A reopen starts attempt #2 (also left hanging for now).
    fire(null)
    fire('host')
    await vi.advanceTimersByTimeAsync(0)
    expect(inject).toHaveBeenCalledTimes(2)

    // Attempt #1's promise settles LATE, after attempt #2 has already
    // started. Because attempt #1 is a stale generation, this must be a
    // no-op: it must not mark the entry 'done' (that would incorrectly
    // short-circuit attempt #2's own outcome), nor should it disturb attempt
    // #2's own pending status.
    resolveFirstAttempt?.(true)
    await vi.advanceTimersByTimeAsync(0)

    // Proof the stale 'true' did not mark the entry done: a reopen while
    // attempt #2 is still genuinely pending must still dedup (no 3rd call)
    // rather than treat the entry as either done or freshly-retryable.
    fire(null)
    fire('host')
    await vi.advanceTimersByTimeAsync(0)
    expect(inject).toHaveBeenCalledTimes(2)

    // Now attempt #2 (the current generation) resolves false — this is the
    // one that must actually govern the entry's fate.
    resolveSecondAttempt?.(false)
    await vi.advanceTimersByTimeAsync(0)

    fire(null)
    fire('host')
    await vi.advanceTimersByTimeAsync(0)
    expect(inject).toHaveBeenCalledTimes(3)
    expect(inject.mock.calls[2]?.[0]).toBe(entry)
  })

  it('clears the per-attempt timeout timer on dispose — no timer survives, and advancing fake time afterward triggers no further inject activity', async () => {
    const { subscribe, emit } = makeFakeSource()
    const { onHostChanged, fire } = makeHostChangedController()
    const entry = { tag: 'disposed-mid-flight' }
    const inject = vi.fn(() => new Promise<boolean>(() => { /* never settles */ }))

    emit(entry)
    const relay = createOpenGatedRelay(onHostChanged, subscribe, inject, { injectTimeoutMs: 5000 })
    fire('host')
    await vi.advanceTimersByTimeAsync(0)
    expect(inject).toHaveBeenCalledTimes(1)

    // The in-flight attempt must have a live timeout timer scheduled.
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    relay.dispose()

    // Dispose must clear it — no pending timer should survive teardown.
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(5000)
    expect(inject).toHaveBeenCalledTimes(1)
  })
})

describe('createOpenGatedRelay — existing semantics unchanged when injectTimeoutMs is configured (minimal cross-check)', () => {
  it('pending in-flight dedup still holds: a concurrent replay before the timeout does not trigger a second inject() call', async () => {
    const { subscribe, emit } = makeFakeSource()
    const { onHostChanged, fire } = makeHostChangedController()
    const entry = { tag: 'in-flight-dedup' }
    const inject = vi.fn(() => new Promise<boolean>(() => { /* never settles within this test */ }))

    emit(entry)
    createOpenGatedRelay(onHostChanged, subscribe, inject, { injectTimeoutMs: 5000 })
    fire('host')
    await vi.advanceTimersByTimeAsync(0)
    expect(inject).toHaveBeenCalledTimes(1)

    // Reopen well before the timeout elapses — the attempt is still
    // genuinely in flight, so this must not re-invoke inject().
    fire('host')
    await vi.advanceTimersByTimeAsync(0)
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('a confirmed true result still marks the entry permanently done: the next reopen never retries it', async () => {
    const { subscribe, emit } = makeFakeSource()
    const { onHostChanged, fire } = makeHostChangedController()
    const entry = { tag: 'confirmed-done' }
    const inject = vi.fn().mockResolvedValue(true)

    emit(entry)
    createOpenGatedRelay(onHostChanged, subscribe, inject, { injectTimeoutMs: 5000 })
    fire('host')
    await vi.advanceTimersByTimeAsync(0)
    expect(inject).toHaveBeenCalledTimes(1)

    fire(null)
    fire('host')
    await vi.advanceTimersByTimeAsync(0)
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('a resolved false result still clears the entry back to retryable immediately, without waiting for injectTimeoutMs', async () => {
    const { subscribe, emit } = makeFakeSource()
    const { onHostChanged, fire } = makeHostChangedController()
    const entry = { tag: 'fails-once-then-ok' }
    const inject = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)

    emit(entry)
    createOpenGatedRelay(onHostChanged, subscribe, inject, { injectTimeoutMs: 5000 })
    fire('host')
    await vi.advanceTimersByTimeAsync(0)
    expect(inject).toHaveBeenCalledTimes(1)

    fire(null)
    fire('host')
    // Deliberately NOT advancing by injectTimeoutMs — a resolved false must
    // free the entry immediately, not merely after the timeout window.
    await vi.advanceTimersByTimeAsync(0)
    expect(inject).toHaveBeenCalledTimes(2)
    expect(inject.mock.calls[1]?.[0]).toBe(entry)
  })
})
