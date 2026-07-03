/**
 * `apiCallWatchdogMs` decides how long bridge-router's one-shot "no handler"
 * watchdog waits before it tears a forwarded simulator-API call down. Network
 * -budget APIs (request/downloadFile/uploadFile) must get the caller's wx
 * timeout budget (`params.timeout` when positive, else the wx default
 * `DEFAULT_REQUEST_TIMEOUT_MS`) plus a 5000ms forwarding grace window;
 * anything else keeps the flat 5000ms window bridge-router used before this
 * API existed.
 *
 * `DEFAULT_REQUEST_TIMEOUT_MS` (shared/request-core.ts) is the single source
 * of truth for the wx default (60000ms) — pinned here too so the watchdog
 * budget cannot silently drift from the actual request timeout default.
 */
import { describe, it, expect } from 'vitest'
import { apiCallWatchdogMs } from './simulator-api-metadata'
import { DEFAULT_REQUEST_TIMEOUT_MS } from './request-core'

describe('DEFAULT_REQUEST_TIMEOUT_MS', () => {
  it('is the wx.request default timeout budget of 60000ms', () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(60_000)
  })
})

describe('apiCallWatchdogMs — network-budget APIs (request/downloadFile/uploadFile)', () => {
  it('request with no params.timeout uses the default budget + 5000ms grace', () => {
    expect(apiCallWatchdogMs('request', {})).toBe(65_000)
    expect(apiCallWatchdogMs('request', {})).toBe(DEFAULT_REQUEST_TIMEOUT_MS + 5_000)
  })

  it('request with a positive params.timeout uses timeout + 5000ms grace', () => {
    expect(apiCallWatchdogMs('request', { timeout: 1000 })).toBe(6_000)
  })

  it('request with a non-positive params.timeout falls back to the default budget', () => {
    expect(apiCallWatchdogMs('request', { timeout: 0 })).toBe(65_000)
  })

  it('request with an absent params object falls back to the default budget', () => {
    expect(apiCallWatchdogMs('request', undefined)).toBe(65_000)
  })

  it('downloadFile and uploadFile share the same network-budget treatment as request', () => {
    expect(apiCallWatchdogMs('downloadFile', {})).toBe(65_000)
    expect(apiCallWatchdogMs('uploadFile', {})).toBe(65_000)
  })
})

describe('apiCallWatchdogMs — every other API keeps the flat 5000ms window', () => {
  it('showToast (a representative non-network API) is unaffected', () => {
    expect(apiCallWatchdogMs('showToast', {})).toBe(5_000)
  })

  it('an absent params object does not change the flat window for a non-network API', () => {
    expect(apiCallWatchdogMs('showToast', undefined)).toBe(5_000)
  })
})
