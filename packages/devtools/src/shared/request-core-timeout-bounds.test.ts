/**
 * `performRequest`'s `opts.timeout` reaches `setTimeout` directly as the
 * delay argument. A non-finite or overflowing value (`Infinity`, `1e12`, ...)
 * is not a "very long timeout" — Node/browsers clamp any `setTimeout` delay
 * above the 32-bit signed max (2147483647ms) down to 1ms, so the timer fires
 * almost immediately and the request is killed as "timed out" within a
 * millisecond of being issued instead of running for the caller's intended
 * (effectively unbounded) budget.
 *
 * "Legal" timeout: `Number.isFinite(t) && t > 0 && t <= 2147483647`. Anything
 * else must fall back to `DEFAULT_REQUEST_TIMEOUT_MS` (60000ms), the same
 * fallback already used for non-positive values.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { performRequest, type RequestFailResult } from './request-core'

/** A fetch stub whose promise never settles on its own — the request only
 * resolves through `performRequest`'s own timeout race. */
function hangingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(() => new Promise(() => {}))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('performRequest — non-finite timeout falls back to the 60000ms default', () => {
  it('Infinity does not fire within 1ms and still falls back to a 60000ms deadline', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', hangingFetch())
    const fail = vi.fn<(err: RequestFailResult) => void>()

    performRequest({ url: 'https://example.com/x', timeout: Infinity }, { fail })

    await vi.advanceTimersByTimeAsync(1)
    expect(fail).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59_999)
    expect(fail).toHaveBeenCalledTimes(1)
    expect(fail.mock.calls[0][0]).toMatchObject({ errMsg: 'request:fail timeout' })
  })

  it('a value exceeding the setTimeout max safe delay also falls back to 60000ms', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', hangingFetch())
    const fail = vi.fn<(err: RequestFailResult) => void>()

    performRequest({ url: 'https://example.com/x', timeout: 1e12 }, { fail })

    await vi.advanceTimersByTimeAsync(1)
    expect(fail).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59_999)
    expect(fail).toHaveBeenCalledTimes(1)
    expect(fail.mock.calls[0][0]).toMatchObject({ errMsg: 'request:fail timeout' })
  })
})
