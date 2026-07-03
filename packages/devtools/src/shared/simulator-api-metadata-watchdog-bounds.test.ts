/**
 * `apiCallWatchdogMs`'s network-budget branch must reject a `params.timeout`
 * that is non-finite or exceeds `setTimeout`'s max safe delay (2^31-1 ==
 * 2147483647ms) instead of passing it through. bridge-router feeds this
 * function's return value directly into its own `setTimeout` (bridge-
 * router.ts, the watchdog timer keyed off `apiCallWatchdogMs(name, params)`),
 * so an oversized or `Infinity` budget does not just describe an oversized
 * wait — it overflows the 32-bit signed delay Node/browsers clamp `setTimeout`
 * to, and the timer the watchdog itself schedules fires almost immediately,
 * killing the call before any real response could arrive.
 *
 * "Legal" timeout: `Number.isFinite(t) && t > 0 && t <= 2147483647`. Anything
 * else falls back to `DEFAULT_REQUEST_TIMEOUT_MS`. The return value is itself
 * clamped to 2147483647 (`Math.min(budget + API_CALL_WATCHDOG_MS, 2147483647)`)
 * because that return value becomes bridge-router's own `setTimeout` delay —
 * a legal 2147483647ms budget plus the 5000ms forwarding grace would
 * otherwise overflow the same limit one layer up.
 */
import { describe, it, expect } from 'vitest'
import { apiCallWatchdogMs } from './simulator-api-metadata'

const MAX_SAFE_DELAY_MS = 2_147_483_647

describe('apiCallWatchdogMs — non-finite params.timeout falls back to the default budget', () => {
  it('Infinity is rejected, not passed through to the watchdog delay', () => {
    expect(apiCallWatchdogMs('request', { timeout: Infinity })).toBe(65_000)
  })

  it('a value larger than the setTimeout max safe delay is rejected', () => {
    expect(apiCallWatchdogMs('request', { timeout: 1e12 })).toBe(65_000)
  })
})

describe('apiCallWatchdogMs — the legal upper bound is honoured without overflowing the return value', () => {
  it('params.timeout at exactly the setTimeout max safe delay is used, and the +5000ms grace is clamped rather than overflowing', () => {
    const result = apiCallWatchdogMs('request', { timeout: MAX_SAFE_DELAY_MS })
    expect(result).toBe(MAX_SAFE_DELAY_MS)
    expect(result).toBeLessThanOrEqual(MAX_SAFE_DELAY_MS)
  })
})
