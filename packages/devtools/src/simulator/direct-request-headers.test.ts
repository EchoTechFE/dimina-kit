/**
 * Header deduplication contract for `directRequest`.
 *
 * The runtime merges a default `Content-Type: application/json` with the
 * caller-supplied `header` map. Because the default key uses title-case
 * (`Content-Type`) while callers often supply lowercase (`content-type`),
 * the plain-object spread `{ 'Content-Type': '…', ...header }` produces two
 * distinct keys that `new Headers()` normalises and joins with a comma,
 * yielding `application/json, application/json` — the duplication bug these
 * tests pin.
 *
 * Contract: the outgoing `content-type` must always be a single, comma-free
 * value. Caller's explicit value wins; runtime default fills the gap only when
 * the caller omits it entirely.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { directRequest } from './direct-request'

// Minimal MiniAppContext seam — mirrors the pattern used in other
// simulator-api tests (e.g. run-api-async.test.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = { appId: 'test-app', createCallbackFunction: (fn: unknown) => (typeof fn === 'function' ? fn as (...a: any[]) => void : undefined) }

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Extract and normalise the outgoing headers from the captured fetch call. */
function capturedHeaders(): Headers {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
  return new Headers(init?.headers as HeadersInit | undefined)
}

/** Fire `directRequest` and wait for the internal fetch promise to settle. */
async function request(args: Parameters<typeof directRequest>[0]): Promise<void> {
  directRequest.call(ctx, args)
  // Let the microtask queue drain so `fetch(…).then(…)` has resolved.
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('directRequest — Content-Type header deduplication', () => {
  it('caller sets lowercase content-type: application/json → exactly one value, no comma', async () => {
    await request({
      url: 'https://example.com/api',
      method: 'POST',
      header: { 'content-type': 'application/json' },
    })

    const headers = capturedHeaders()
    const ct = headers.get('content-type')

    // Must be exactly the single value — NOT 'application/json, application/json'
    expect(ct).not.toContain(',')
    expect(ct).toBe('application/json')
  })

  it('caller sets NO content-type → runtime default applied exactly once', async () => {
    await request({
      url: 'https://example.com/api',
      method: 'POST',
      header: {},
    })

    const headers = capturedHeaders()
    const ct = headers.get('content-type')

    expect(ct).not.toContain(',')
    expect(ct).toBe('application/json')
  })

  it('caller sets Content-Type with different casing (title-case) and custom value → caller wins, single value', async () => {
    await request({
      url: 'https://example.com/api',
      method: 'POST',
      header: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })

    const headers = capturedHeaders()
    const ct = headers.get('content-type')

    // Caller's value must win and appear exactly once — default must NOT be appended
    expect(ct).not.toContain(',')
    expect(ct).toBe('application/x-www-form-urlencoded')
  })

  it('caller sets an unrelated header alongside absent content-type → both header and default survive correctly', async () => {
    await request({
      url: 'https://example.com/api',
      method: 'POST',
      header: { 'x-token': 'abc' },
    })

    const headers = capturedHeaders()

    // Unrelated caller header must pass through
    expect(headers.get('x-token')).toBe('abc')

    // Runtime default still applied, exactly once
    const ct = headers.get('content-type')
    expect(ct).not.toContain(',')
    expect(ct).toBe('application/json')
  })
})
