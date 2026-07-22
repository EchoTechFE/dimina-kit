import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { buildNetworkOnlyHookScript, installGlobalNetworkBodyGate } from './global-body-gate.js'
import type { NetworkBodyProvider } from './index.js'

// ── buildNetworkOnlyHookScript — pure string generation ─────────────────────

describe('buildNetworkOnlyHookScript', () => {
  it('returns a non-empty string', () => {
    const src = buildNetworkOnlyHookScript()
    expect(typeof src).toBe('string')
    expect(src.length).toBeGreaterThan(0)
  })

  it('wraps InspectorFrontendHost.sendMessageToBackend and gates on the dimina:sim: prefix', () => {
    const src = buildNetworkOnlyHookScript()
    expect(src).toContain('InspectorFrontendHost')
    expect(src).toContain('sendMessageToBackend')
    expect(src).toContain('dimina:sim:')
  })

  it('is a pure function — repeated calls return identical content', () => {
    expect(buildNetworkOnlyHookScript()).toBe(buildNetworkOnlyHookScript())
  })
})

// ── installGlobalNetworkBodyGate — behavioral tests against a fake hostWc ───

function makeHostWc(execImpl: (script: string) => Promise<unknown>) {
  const exec = vi.fn(execImpl)
  const wc = {
    isDestroyed: () => false,
    isLoading: () => false,
    getURL: () => 'devtools://devtools/bundled/devtools_app.html',
    executeJavaScript: exec,
  }
  return { wc: wc as unknown as WebContents, exec }
}

function makeBodies(overrides: Partial<NetworkBodyProvider> = {}): NetworkBodyProvider {
  return {
    getResponseBody: vi.fn(() => Promise.resolve({ body: '', base64Encoded: false })),
    getRequestPostData: vi.fn(() => Promise.resolve({ postData: '' })),
    ...overrides,
  }
}

/** Drain the microtask queue without advancing any fake timer. */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/** Reconcile-tick scripts always splice the outbound queue; replies never do. */
function isReplyScript(script: unknown): script is string {
  return typeof script === 'string' && script.includes('dispatchMessage')
}

describe('installGlobalNetworkBodyGate', () => {
  it('installs and ticks with no pending commands — no extra dispatch calls', async () => {
    vi.useFakeTimers()
    try {
      const { wc, exec } = makeHostWc(async () => ({ status: 'installed', batch: [] }))
      const bodies = makeBodies()
      const stop = installGlobalNetworkBodyGate(wc, bodies)

      await vi.advanceTimersByTimeAsync(150)
      await flushMicrotasks()

      expect(exec).toHaveBeenCalledTimes(1)
      expect(bodies.getResponseBody).not.toHaveBeenCalled()
      expect(bodies.getRequestPostData).not.toHaveBeenCalled()
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('intercepts a dimina:sim: Network.getResponseBody command and answers from the provider', async () => {
    vi.useFakeTimers()
    try {
      let tick = 0
      const { wc, exec } = makeHostWc(async () => {
        tick++
        if (tick === 1) {
          return {
            status: 'installed',
            batch: [{ id: 1, method: 'Network.getResponseBody', params: { requestId: 'dimina:sim:1:0:raw1' }, sessionId: null }],
          }
        }
        return { status: 'installed', batch: [] }
      })
      const getResponseBody = vi.fn(() => Promise.resolve({ body: 'hello', base64Encoded: false }))
      const bodies = makeBodies({ getResponseBody })
      const stop = installGlobalNetworkBodyGate(wc, bodies)

      await vi.advanceTimersByTimeAsync(150)
      await flushMicrotasks()

      expect(getResponseBody).toHaveBeenCalledExactlyOnceWith('dimina:sim:1:0:raw1')

      const replies = exec.mock.calls.map((c) => c[0] as string).filter(isReplyScript)
      expect(replies.length).toBeGreaterThan(0)
      const reply = replies[replies.length - 1]
      // The reply payload is JSON-stringified once (to build the CDP message) and
      // then JSON.stringify'd again to embed as a JS string literal in the
      // executeJavaScript source, so quotes around keys appear backslash-escaped
      // in the raw script text — tolerate the escaping rather than assume none.
      expect(reply).toMatch(/\\?"id\\?":1\b/)
      expect(reply).toContain('hello')
      expect(reply).not.toMatch(/\\?"error\\?":/)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes Network.getRequestPostData to bodies.getRequestPostData, not getResponseBody', async () => {
    vi.useFakeTimers()
    try {
      let tick = 0
      const { wc, exec } = makeHostWc(async () => {
        tick++
        if (tick === 1) {
          return {
            status: 'installed',
            batch: [{ id: 2, method: 'Network.getRequestPostData', params: { requestId: 'dimina:sim:1:0:raw2' }, sessionId: null }],
          }
        }
        return { status: 'installed', batch: [] }
      })
      const getRequestPostData = vi.fn(() => Promise.resolve({ postData: 'a=1&b=2' }))
      const getResponseBody = vi.fn(() => Promise.resolve({ body: '', base64Encoded: false }))
      const bodies = makeBodies({ getRequestPostData, getResponseBody })
      const stop = installGlobalNetworkBodyGate(wc, bodies)

      await vi.advanceTimersByTimeAsync(150)
      await flushMicrotasks()

      expect(getRequestPostData).toHaveBeenCalledExactlyOnceWith('dimina:sim:1:0:raw2')
      expect(getResponseBody).not.toHaveBeenCalled()

      const replies = exec.mock.calls.map((c) => c[0] as string).filter(isReplyScript)
      const reply = replies[replies.length - 1]
      expect(reply).toMatch(/\\?"id\\?":2\b/)
      expect(reply).toContain('a=1&b=2')
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('replies with a CDP not-found-shaped error when the provider lookup rejects', async () => {
    vi.useFakeTimers()
    try {
      let tick = 0
      const { wc, exec } = makeHostWc(async () => {
        tick++
        if (tick === 1) {
          return {
            status: 'installed',
            batch: [{ id: 3, method: 'Network.getResponseBody', params: { requestId: 'dimina:sim:1:0:raw3' }, sessionId: null }],
          }
        }
        return { status: 'installed', batch: [] }
      })
      const getResponseBody = vi.fn(() => Promise.reject(new Error('no such body')))
      const bodies = makeBodies({ getResponseBody })
      const stop = installGlobalNetworkBodyGate(wc, bodies)

      await vi.advanceTimersByTimeAsync(150)
      await flushMicrotasks()

      const replies = exec.mock.calls.map((c) => c[0] as string).filter(isReplyScript)
      const reply = replies[replies.length - 1]
      expect(reply).toMatch(/\\?"id\\?":3\b/)
      expect(reply).toMatch(/\\?"error\\?":/)
      expect(reply).toMatch(/-32000/)
      expect(reply).toContain('no such body')
      expect(reply).not.toMatch(/\\?"result\\?":/)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop() halts further reconcile ticks', async () => {
    vi.useFakeTimers()
    try {
      const { wc, exec } = makeHostWc(async () => ({ status: 'installed', batch: [] }))
      const bodies = makeBodies()
      const stop = installGlobalNetworkBodyGate(wc, bodies)

      await vi.advanceTimersByTimeAsync(150)
      await flushMicrotasks()
      expect(exec).toHaveBeenCalledTimes(1)

      stop()
      exec.mockClear()
      await vi.advanceTimersByTimeAsync(450)
      await flushMicrotasks()
      expect(exec).toHaveBeenCalledTimes(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('self-stops once hostWc.isDestroyed() becomes true, without a manual stop() call', async () => {
    vi.useFakeTimers()
    try {
      let destroyed = false
      const exec = vi.fn(async () => ({ status: 'installed', batch: [] }))
      const wc = {
        isDestroyed: () => destroyed,
        isLoading: () => false,
        getURL: () => 'devtools://devtools/bundled/devtools_app.html',
        executeJavaScript: exec,
      } as unknown as WebContents
      const bodies = makeBodies()
      installGlobalNetworkBodyGate(wc, bodies)

      await vi.advanceTimersByTimeAsync(150)
      await flushMicrotasks()
      expect(exec).toHaveBeenCalledTimes(1)

      destroyed = true
      exec.mockClear()
      await vi.advanceTimersByTimeAsync(450)
      await flushMicrotasks()
      expect(exec).toHaveBeenCalledTimes(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
