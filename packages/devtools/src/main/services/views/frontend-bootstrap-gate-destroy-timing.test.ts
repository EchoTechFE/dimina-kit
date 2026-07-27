/**
 * `whenFrontendBootstrapped` destroy-timing tests: an independent
 * adversarial pass probing "the wc gets destroyed at every distinct await
 * point of the poll chain", per the module's own contract ("resolves...
 * false on... a destroyed wc — never rejects, and never leaves a live timer
 * behind after settling").
 *
 * The poll chain (see `frontend-bootstrap-gate.ts`'s `attempt()`) has exactly
 * two distinguishable await points per round:
 *   (a) the in-flight `wc.executeJavaScript(...)` call itself (destroy while
 *       that promise is unresolved);
 *   (c) the interval wait between a legitimately-not-ready, not-yet-destroyed
 *       round and the next `attempt()` firing (destroy while `setTimeout` is
 *       armed but hasn't fired).
 * A third point the task brief names — "destroy after the probe resolves,
 * before the `setTimeout` is armed" — collapses into (a): between the probe
 * promise settling and the timer being armed, `attempt()`'s `.then()`
 * callback runs its `ready`/`isDestroyed()` checks and calls `setTimeout`
 * entirely SYNCHRONOUSLY, with no further await in between — there is no
 * externally-reachable instant to land a destroy "between" those two steps
 * distinct from landing it during the still-pending probe call itself. It is
 * not stably observable and is not faked with a separate test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { whenFrontendBootstrapped } from './frontend-bootstrap-gate.js'
import type { WebContents } from 'electron'

function createMockWc(destroyed = false) {
  let isDestroyedFlag = destroyed
  const executeJavaScript = vi.fn()
  return {
    executeJavaScript,
    isDestroyed: () => isDestroyedFlag,
    setDestroyed(v: boolean) { isDestroyedFlag = v },
  }
}

const asWc = (wc: ReturnType<typeof createMockWc>): WebContents => wc as unknown as WebContents

/** A promise this test controls the settlement of, for simulating an
 *  in-flight `executeJavaScript` call the test can resolve at a chosen
 *  instant. */
function deferred<T>(): { promise: Promise<T>, resolve: (v: T) => void, reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

let unhandledRejections: unknown[] = []
function onUnhandled(reason: unknown): void { unhandledRejections.push(reason) }

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  process.removeListener('unhandledRejection', onUnhandled)
  unhandledRejections = []
})

describe('whenFrontendBootstrapped — destroy while the FIRST probe call is still in-flight', () => {
  it('resolves false, with no live timer and no unhandled rejection, when the in-flight probe legitimately settles false after destroy', async () => {
    process.on('unhandledRejection', onUnhandled)
    const wc = createMockWc()
    const first = deferred<boolean>()
    wc.executeJavaScript.mockReturnValueOnce(first.promise)

    const resultPromise = whenFrontendBootstrapped(asWc(wc), { timeoutMs: 5000, intervalMs: 100 })
    // Let attempt()'s `Promise.resolve().then(() => wc.executeJavaScript(...))`
    // actually reach the executeJavaScript call.
    await Promise.resolve()
    await Promise.resolve()
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(1)

    wc.setDestroyed(true)
    first.resolve(false)
    await expect(resultPromise).resolves.toBe(false)

    expect(unhandledRejections, 'no unhandled rejection may escape the poll chain').toEqual([])
    // No further probe call was ever made — the destroyed check inside the
    // `.then()` chain (`if (wc.isDestroyed()) { finish(false); return }`)
    // short-circuits before any setTimeout/next attempt.
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(1)
  })

  it('resolves false, with no unhandled rejection, when the in-flight probe REJECTS after destroy (execution context torn down mid-call)', async () => {
    process.on('unhandledRejection', onUnhandled)
    const wc = createMockWc()
    const first = deferred<boolean>()
    wc.executeJavaScript.mockReturnValueOnce(first.promise)

    const resultPromise = whenFrontendBootstrapped(asWc(wc), { timeoutMs: 5000, intervalMs: 100 })
    await Promise.resolve()
    await Promise.resolve()

    wc.setDestroyed(true)
    first.reject(new Error('execution context was destroyed'))
    await expect(resultPromise).resolves.toBe(false)

    expect(unhandledRejections).toEqual([])
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(1)
  })

  /**
   * ADVERSARIAL FINDING (this test is expected to FAIL against the current
   * implementation): `attempt()`'s `.then((ready) => { if (ready) {
   * finish(true); return } ... })` finishes `true` the instant the probe
   * value is truthy — it never re-checks `wc.isDestroyed()` in that branch
   * (only the `!ready` branch does). If the in-flight probe call happens to
   * resolve `true` after the target was destroyed mid-flight (a genuinely
   * possible race: the JS evaluation on the front-end side completed and the
   * IPC round-trip was already committed before the destroy signal reached
   * this process), `whenFrontendBootstrapped` reports the front-end
   * bootstrapped and ready — on a target that is no longer usable. This
   * contradicts the module doc's "false on... a destroyed wc" contract for
   * this specific interleaving. Documented here, not fixed (test-author
   * scope is tests only).
   */
  it('ADVERSARIAL FINDING: resolves true (not false) when the in-flight probe resolves true AFTER the wc was destroyed mid-flight', async () => {
    const wc = createMockWc()
    const first = deferred<boolean>()
    wc.executeJavaScript.mockReturnValueOnce(first.promise)

    const resultPromise = whenFrontendBootstrapped(asWc(wc), { timeoutMs: 5000, intervalMs: 100 })
    await Promise.resolve()
    await Promise.resolve()

    wc.setDestroyed(true)
    first.resolve(true)
    const result = await resultPromise

    // This assertion encodes the CORRECT invariant per the module's own doc
    // ("false on ... a destroyed wc"); it currently fails because the `ready`
    // branch never re-checks `isDestroyed()`.
    expect(
      result,
      'a probe that resolves true for an ALREADY-DESTROYED wc must not be trusted as "bootstrapped" — the true-branch never re-checks isDestroyed()',
    ).toBe(false)
  })
})

describe('whenFrontendBootstrapped — destroy while the interval timer is armed (between a not-ready round and the next attempt)', () => {
  it('resolves false and makes no further probe call once the armed interval timer fires against an already-destroyed wc', async () => {
    process.on('unhandledRejection', onUnhandled)
    vi.useFakeTimers()
    const wc = createMockWc()
    wc.executeJavaScript.mockResolvedValue(false) // legitimately not-ready, not destroyed yet

    const resultPromise = whenFrontendBootstrapped(asWc(wc), { timeoutMs: 5000, intervalMs: 100 })
    await vi.advanceTimersByTimeAsync(0)
    expect(wc.executeJavaScript, 'first round: probed once, resolved false, timer armed for the next round').toHaveBeenCalledTimes(1)

    // Destroy strictly DURING the interval wait — the armed setTimeout has
    // not fired yet.
    wc.setDestroyed(true)

    await vi.advanceTimersByTimeAsync(100)
    await expect(resultPromise).resolves.toBe(false)
    // attempt()'s very first line (`if (wc.isDestroyed()) { finish(false); return }`)
    // must have short-circuited before calling executeJavaScript again.
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(1)

    const callsAtSettle = wc.executeJavaScript.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(wc.executeJavaScript, 'no live timer may resurrect polling after settling').toHaveBeenCalledTimes(callsAtSettle)
    expect(unhandledRejections).toEqual([])
  })
})
