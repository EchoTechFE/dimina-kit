/**
 * `onHeadersReceived` is the sole authority for the three CORS response
 * headers on simulator sessions. Electron's `details.responseHeaders` keys
 * are raw, case-preserving strings — a server that already sends
 * `Access-Control-Allow-Origin` (title-case) and a hook that injects the
 * lowercase `access-control-allow-origin` key produce TWO distinct object
 * keys. Both survive into the callback's `responseHeaders`, so Chromium
 * treats them as one duplicated header (`*, *`) and rejects the response
 * under the CORS spec — every request to a backend that sends its own CORS
 * headers fails with "Failed to fetch" in the simulator.
 *
 * The contract: after this hook runs, each of
 * access-control-allow-origin / -headers / -methods appears exactly once
 * (case-insensitively) with value `['*']`, and any pre-existing casing of
 * those keys is removed rather than left to collide. Unrelated headers pass
 * through untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type ResponseHeaders = Record<string, string[]>
type HeadersReceivedDetails = { responseHeaders?: ResponseHeaders }
type HeadersReceivedCallback = (response: { responseHeaders?: ResponseHeaders }) => void
type HeadersReceivedListener = (
  details: HeadersReceivedDetails,
  callback: HeadersReceivedCallback,
) => void

type RequestHeaders = Record<string, string>
type BeforeSendHeadersDetails = { requestHeaders: RequestHeaders }
type BeforeSendHeadersCallback = (response: { requestHeaders: RequestHeaders }) => void
type BeforeSendHeadersListener = (
  details: BeforeSendHeadersDetails,
  callback: BeforeSendHeadersCallback,
) => void

type FakeSession = {
  webRequest: {
    onBeforeSendHeaders: ReturnType<typeof vi.fn<(listener: BeforeSendHeadersListener | null) => void>>
    onHeadersReceived: ReturnType<typeof vi.fn<(listener: HeadersReceivedListener | null) => void>>
  }
}

const h = vi.hoisted(() => {
  const sessions = new Map<string, FakeSession>()
  function makeSession(): FakeSession {
    return {
      webRequest: {
        onBeforeSendHeaders: vi.fn<(listener: BeforeSendHeadersListener | null) => void>(),
        onHeadersReceived: vi.fn<(listener: HeadersReceivedListener | null) => void>(),
      },
    }
  }
  const fromPartition = vi.fn<(partition: string) => FakeSession>((partition: string) => {
    let sess = sessions.get(partition)
    if (!sess) {
      sess = makeSession()
      sessions.set(partition, sess)
    }
    return sess
  })
  return { sessions, fromPartition }
})

vi.mock('electron', () => ({
  session: { fromPartition: h.fromPartition },
}))

vi.mock('./miniapp-partition.js', () => ({
  SHARED_MINIAPP_PARTITION: 'persist:simulator',
  registerMiniappSessionConfigurator: vi.fn(() => () => {}),
}))

beforeEach(() => {
  h.sessions.clear()
  h.fromPartition.mockClear()
})

/** Runs `setupSimulatorSessionPolicy` and returns the `onHeadersReceived`
 * listener it installed on the shared fallback session. */
async function installedHeadersReceivedListener(): Promise<HeadersReceivedListener> {
  const { setupSimulatorSessionPolicy } = await import('./simulator-session-policy.js')
  setupSimulatorSessionPolicy()
  const sharedSession = h.fromPartition.mock.results[0]?.value as FakeSession
  const [listener] = sharedSession.webRequest.onHeadersReceived.mock.calls[0] as [
    HeadersReceivedListener,
  ]
  return listener
}

/** Invokes `listener` with `responseHeaders` and captures what it hands to `callback`. */
function runListener(
  listener: HeadersReceivedListener,
  responseHeaders: ResponseHeaders,
): ResponseHeaders {
  let captured: ResponseHeaders | undefined
  listener({ responseHeaders }, (response) => {
    captured = response.responseHeaders ?? {}
  })
  if (!captured) throw new Error('listener did not invoke callback synchronously')
  return captured
}

/** Case-insensitively counts and reads values for `name` in `headers`. */
function findCaseInsensitive(
  headers: ResponseHeaders,
  name: string,
): { count: number; values: string[][] } {
  const lower = name.toLowerCase()
  const matches = Object.entries(headers).filter(([key]) => key.toLowerCase() === lower)
  return { count: matches.length, values: matches.map(([, value]) => value) }
}

describe('simulator session policy onHeadersReceived CORS injection', () => {
  it('collapses a pre-existing title-case Access-Control-Allow-Origin into a single lowercase entry', async () => {
    const listener = await installedHeadersReceivedListener()
    const result = runListener(listener, {
      'Access-Control-Allow-Origin': ['*'],
    })
    const origin = findCaseInsensitive(result, 'access-control-allow-origin')
    expect(origin.count).toBe(1)
    expect(origin.values[0]).toEqual(['*'])
  })

  it('overrides a pre-existing non-wildcard origin value down to a single wildcard entry', async () => {
    const listener = await installedHeadersReceivedListener()
    const result = runListener(listener, {
      'Access-Control-Allow-Origin': ['https://example.com'],
    })
    const origin = findCaseInsensitive(result, 'access-control-allow-origin')
    expect(origin.count).toBe(1)
    expect(origin.values[0]).toEqual(['*'])
  })

  it('collapses all three CORS headers when the server sends mixed casing for each', async () => {
    const listener = await installedHeadersReceivedListener()
    const result = runListener(listener, {
      'Access-Control-Allow-Origin': ['https://example.com'],
      'access-Control-allow-Headers': ['X-Custom'],
      'ACCESS-CONTROL-ALLOW-METHODS': ['GET'],
    })
    const origin = findCaseInsensitive(result, 'access-control-allow-origin')
    const headers = findCaseInsensitive(result, 'access-control-allow-headers')
    const methods = findCaseInsensitive(result, 'access-control-allow-methods')
    expect(origin.count).toBe(1)
    expect(origin.values[0]).toEqual(['*'])
    expect(headers.count).toBe(1)
    expect(headers.values[0]).toEqual(['*'])
    expect(methods.count).toBe(1)
    expect(methods.values[0]).toEqual(['*'])
  })

  it('leaves unrelated response headers untouched', async () => {
    const listener = await installedHeadersReceivedListener()
    const result = runListener(listener, {
      'Content-Type': ['application/json'],
    })
    expect(result['Content-Type']).toEqual(['application/json'])
    const origin = findCaseInsensitive(result, 'access-control-allow-origin')
    expect(origin.count).toBe(1)
    expect(origin.values[0]).toEqual(['*'])
  })

  it('injects all three CORS headers exactly once each when none were present', async () => {
    const listener = await installedHeadersReceivedListener()
    const result = runListener(listener, {})
    const origin = findCaseInsensitive(result, 'access-control-allow-origin')
    const headers = findCaseInsensitive(result, 'access-control-allow-headers')
    const methods = findCaseInsensitive(result, 'access-control-allow-methods')
    expect(origin.count).toBe(1)
    expect(origin.values[0]).toEqual(['*'])
    expect(headers.count).toBe(1)
    expect(headers.values[0]).toEqual(['*'])
    expect(methods.count).toBe(1)
    expect(methods.values[0]).toEqual(['*'])
  })
})
