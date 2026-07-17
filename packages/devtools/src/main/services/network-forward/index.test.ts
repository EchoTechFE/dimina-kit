/**
 * Behavior tests for createNetworkForwarder.
 *
 * The forwarder attaches the CDP debugger to the simulator WCV, watches the
 * Network domain, and re-emits each COMPLETED request as one `[网络]` line into
 * the service-host console (via `executeJavaScript`, where the embedded DevTools
 * is attached). These tests assert:
 *   - a request only forwards on completion (requestWillBeSent → response →
 *     loadingFinished), carrying method/status/url as JSON DATA (never code);
 *   - a failed request forwards with its errorText at warn level;
 *   - re-attaching to a new WCV detaches the previous one;
 *   - a missing/destroyed service host never throws;
 *   - dispose detaches the debugger.
 *
 * No electron binary is needed: the WCVs are fakes exposing the small
 * `debugger`/`executeJavaScript`/`isDestroyed` surface the forwarder touches.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { createConnectionRegistry, type Connection, type ConnectionRegistry, type Disposable } from '@dimina-kit/electron-deck/main'
import {
  createNetworkForwarder,
  rewriteRequestId,
  RequestIdNamespace,
  REWRITE_REQUEST_ID_METHODS,
  FORWARDED_METHODS,
  VIRTUAL_REQUEST_ID_PREFIX,
} from './index.js'
// Contract under test in the "prefetch admission control" describe block below:
// the size preflight must consult the SAME limit PrefetchCache enforces on a
// settled entry, not a hand-picked number this test guesses at.
import { DEFAULT_PER_ENTRY_MAX_CHARS } from './body-cache.js'

/** Run all pending microtasks (the native dispatch path is microtask-flushed). */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

type DbgListener = (event: unknown, method: string, params: unknown) => void

function makeSimWc() {
  let attached = false
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const sendCommand = vi.fn((_method: string, _params?: object) => Promise.resolve({}) as Promise<unknown>)
  const dbg = {
    isAttached: () => attached,
    attach: vi.fn(() => { attached = true }),
    detach: vi.fn(() => { attached = false }),
    sendCommand,
    on: (ev: string, fn: (...args: unknown[]) => void) => {
      if (!listeners.has(ev)) listeners.set(ev, new Set())
      listeners.get(ev)!.add(fn)
    },
    removeListener: (ev: string, fn: (...args: unknown[]) => void) => {
      listeners.get(ev)?.delete(fn)
    },
  }
  const wc = {
    isDestroyed: () => false,
    debugger: dbg,
    once: () => {},
    removeListener: () => {},
  } as unknown as WebContents
  const emitMessage = (method: string, params: unknown) => {
    for (const fn of listeners.get('message') ?? []) (fn as DbgListener)({}, method, params)
  }
  return { wc, dbg, sendCommand, emitMessage }
}

function makeServiceWc() {
  const exec = vi.fn((_script: string, _userGesture?: boolean) => Promise.resolve(undefined))
  const wc = { isDestroyed: () => false, executeJavaScript: exec } as unknown as WebContents
  return { wc, exec }
}

/**
 * A DevTools FRONT-END host wc. The injected dispatch script returns `true` when
 * `window.DevToolsAPI.dispatchMessage` is "present", so the fake resolves the
 * configured value to simulate the API being ready (true) or still booting
 * (false → forwarder retries / falls back).
 */
function makeDevtoolsWc(
  apiReady: boolean | (() => boolean) = true,
  isLoading: () => boolean = () => false,
) {
  const exec = vi.fn((_script: string, _userGesture?: boolean) =>
    Promise.resolve(typeof apiReady === 'function' ? apiReady() : apiReady))
  // The forwarder watches the host wc's 'destroyed' event to auto-clear the
  // DevTools host (host-destroyed cleanup lives in network-forward, not
  // view-manager). Expose a minimal once/removeListener so that path runs.
  const destroyedListeners = new Set<() => void>()
  const wc = {
    isDestroyed: () => false,
    isLoading,
    getURL: () => 'devtools://devtools/bundled/devtools_app.html',
    executeJavaScript: exec,
    once: (ev: string, fn: () => void) => { if (ev === 'destroyed') destroyedListeners.add(fn) },
    removeListener: (ev: string, fn: () => void) => { if (ev === 'destroyed') destroyedListeners.delete(fn) },
  } as unknown as WebContents
  const emitDestroyed = () => { for (const fn of [...destroyedListeners]) fn() }
  return { wc, exec, emitDestroyed }
}

/** Decode the messages array embedded in a buildDispatchScript() source. */
function decodeDispatched(script: string): Array<{ method: string; params: unknown }> {
  // The script embeds `JSON.parse("<json>")` where <json> is a JSON string that
  // itself encodes the messages array. Scan the first JSON string literal after
  // `JSON.parse(` rather than regex (escaped quotes break a naive pattern).
  const start = script.indexOf('JSON.parse("')
  if (start < 0) return []
  let i = start + 'JSON.parse('.length // points at the opening quote
  const open = i
  i++ // past opening quote
  for (; i < script.length; i++) {
    if (script[i] === '\\') { i++; continue }
    if (script[i] === '"') break
  }
  const literal = script.slice(open, i + 1) // includes both quotes
  const inner = JSON.parse(literal) as string // messages-array JSON string
  const arr = JSON.parse(inner) as string[]
  return arr.map((s) => JSON.parse(s) as { method: string; params: unknown })
}

describe('createNetworkForwarder', () => {
  it('attaches the debugger and enables the Network domain on attachSimulator', () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })

    fwd.attachSimulator(sim.wc)

    expect(sim.dbg.attach).toHaveBeenCalledWith('1.3')
    expect(sim.sendCommand).toHaveBeenCalledWith('Network.enable')
  })

  it('forwards a completed request into the service host with method/status/url as JSON data', () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', {
      requestId: '1', request: { url: 'https://api.test/x', method: 'POST' },
    })
    // Nothing forwarded until completion.
    expect(svc.exec).not.toHaveBeenCalled()

    sim.emitMessage('Network.responseReceived', { requestId: '1', response: { status: 201 } })
    sim.emitMessage('Network.loadingFinished', { requestId: '1' })

    expect(svc.exec).toHaveBeenCalledTimes(1)
    const script = String(svc.exec.mock.calls[0]![0])
    expect(script).toContain('[网络]')
    // The record is carried as a JSON literal (data, not interpolated code).
    expect(script).toContain(JSON.stringify(JSON.stringify({
      source: 'service', url: 'https://api.test/x', method: 'POST', status: 201,
    })))
  })

  it('forwards a failed request with its errorText', () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', {
      requestId: '7', request: { url: 'https://api.test/down', method: 'GET' },
    })
    sim.emitMessage('Network.loadingFailed', { requestId: '7', errorText: 'net::ERR_FAILED' })

    expect(svc.exec).toHaveBeenCalledTimes(1)
    const script = String(svc.exec.mock.calls[0]![0])
    // The record is carried as a JSON literal; a failed request keeps status 0
    // and carries the errorText through.
    expect(script).toContain(JSON.stringify(JSON.stringify({
      source: 'service', url: 'https://api.test/down', method: 'GET', status: 0,
      errorText: 'net::ERR_FAILED',
    })))
  })

  it('does not forward an unmatched completion (no requestWillBeSent)', () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.loadingFinished', { requestId: 'ghost' })

    expect(svc.exec).not.toHaveBeenCalled()
  })

  it('re-attaching to a new WCV detaches the previous one', () => {
    const a = makeSimWc()
    const b = makeSimWc()
    const svc = makeServiceWc()
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })

    fwd.attachSimulator(a.wc)
    fwd.attachSimulator(b.wc)

    expect(a.dbg.detach).toHaveBeenCalledTimes(1)
    expect(b.dbg.attach).toHaveBeenCalledWith('1.3')
  })

  it('never throws when the service host is missing', () => {
    const sim = makeSimWc()
    const fwd = createNetworkForwarder({ getServiceWc: () => null })
    fwd.attachSimulator(sim.wc)

    expect(() => {
      sim.emitMessage('Network.requestWillBeSent', {
        requestId: '1', request: { url: 'https://x', method: 'GET' },
      })
      sim.emitMessage('Network.loadingFinished', { requestId: '1' })
    }).not.toThrow()
  })

  it('report() surfaces a request that no debugger observed', () => {
    const svc = makeServiceWc()
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })

    fwd.report({ source: 'service', url: 'https://direct/x', method: 'GET', status: 200 })

    expect(svc.exec).toHaveBeenCalledTimes(1)
    expect(String(svc.exec.mock.calls[0]![0])).toContain('https://direct/x')
  })

  it('dispose detaches the debugger', () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.attachSimulator(sim.wc)

    void fwd.dispose()

    expect(sim.dbg.detach).toHaveBeenCalledTimes(1)
  })
})

// ── requestId namespacing (pure) ─────────────────────────────────────────────

describe('rewriteRequestId', () => {
  it('rewrites requestId for tracked methods into the dimina:sim namespace', () => {
    const ns = new RequestIdNamespace('E1')
    const out = rewriteRequestId('Network.requestWillBeSent', { requestId: 'r1', request: {} }, ns)
    expect((out.params as { requestId: string }).requestId).toMatch(/^dimina:sim:E1:\d+:r1$/)
  })

  it('does NOT mutate the input params object', () => {
    const ns = new RequestIdNamespace('E1')
    const params = { requestId: 'r1', request: { url: 'x' } }
    rewriteRequestId('Network.requestWillBeSent', params, ns)
    expect(params.requestId).toBe('r1') // original untouched
  })

  it('reuses the SAME virtual id across a request lifecycle (redirect-safe)', () => {
    const ns = new RequestIdNamespace('E1')
    const a = rewriteRequestId('Network.requestWillBeSent', { requestId: 'r1' }, ns)
    const b = rewriteRequestId('Network.responseReceived', { requestId: 'r1' }, ns)
    const c = rewriteRequestId('Network.loadingFinished', { requestId: 'r1' }, ns)
    const va = (a.params as { requestId: string }).requestId
    const vb = (b.params as { requestId: string }).requestId
    const vc = (c.params as { requestId: string }).requestId
    expect(va).toBe(vb)
    expect(vb).toBe(vc)
  })

  it('lazily creates a mapping when an ExtraInfo event precedes requestWillBeSent', () => {
    const ns = new RequestIdNamespace('E1')
    const extra = rewriteRequestId('Network.requestWillBeSentExtraInfo', { requestId: 'r9' }, ns)
    const main = rewriteRequestId('Network.requestWillBeSent', { requestId: 'r9' }, ns)
    expect((extra.params as { requestId: string }).requestId)
      .toBe((main.params as { requestId: string }).requestId)
  })

  it('leaves untracked methods and malformed params unchanged', () => {
    const ns = new RequestIdNamespace('E1')
    const params = { foo: 1 }
    const out = rewriteRequestId('Network.someOtherEvent', params, ns)
    expect(out.params).toBe(params)
    const noId = rewriteRequestId('Network.requestWillBeSent', { request: {} }, ns)
    expect(noId.params).toEqual({ request: {} })
  })

  it('keeps the forwarded/rewrite method sets disjointly correct', () => {
    // dataReceived is namespaced but NOT forwarded (二期).
    expect(REWRITE_REQUEST_ID_METHODS.has('Network.dataReceived')).toBe(true)
    expect(FORWARDED_METHODS.has('Network.dataReceived')).toBe(false)
    // Core lifecycle is both rewritten and forwarded.
    for (const m of ['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed']) {
      expect(REWRITE_REQUEST_ID_METHODS.has(m)).toBe(true)
      expect(FORWARDED_METHODS.has(m)).toBe(true)
    }
  })
})

describe('RequestIdNamespace active/retired TTL/LRU', () => {
  // A freshly-resolved entry is ACTIVE and exempt from TTL/LRU; only RETIRED
  // (terminal) entries age out. Evicting still-active entries would orphan their
  // later response/completion events in the panel.
  it('does NOT expire an ACTIVE mapping; expires it only after retire + TTL', () => {
    let t = 0
    const ns = new RequestIdNamespace('E1', 1000, 1000, () => t)
    const first = ns.resolve('r1')
    t = 5000 // far past the TTL, but r1 is still active (no terminal seen)
    expect(ns.resolve('r1')).toBe(first) // active → never expires

    ns.retire('r1') // terminal event → now retired with a fresh TTL from t=5000
    t = 5500
    expect(ns.resolve('r1')).toBe(first) // within retired TTL → same id
    t = 7000 // > 5000 + 1000 TTL
    expect(ns.resolve('r1')).not.toBe(first) // retired entry aged out → fresh id
  })

  it('LRU only trims RETIRED entries; active entries are exempt from the cap', () => {
    const ns = new RequestIdNamespace('E1', 60_000, 3)
    // Four ACTIVE requests: none may be evicted, even past the cap of 3.
    ns.resolve('a'); ns.resolve('b'); ns.resolve('c'); ns.resolve('d')
    expect(ns.size).toBe(4)
    expect(ns.activeSize).toBe(4)

    // Retire the three oldest → they become eligible; resolving a 5th trims the
    // retired pool back toward the cap while the active 'd' survives.
    ns.retire('a'); ns.retire('b'); ns.retire('c')
    ns.resolve('e') // active; eviction runs over retired only
    expect(ns.size).toBe(3) // capped (active 'd' + 'e' + one surviving retired)
    expect(ns.activeSize).toBe(2) // 'd' and 'e' still active
  })
})

// ── native DevTools front-end sink ───────────────────────────────────────────

describe('createNetworkForwarder — native DevTools dispatch', () => {
  it('forwards raw CDP lifecycle events into the DevTools front-end (not the console)', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const dt = makeDevtoolsWc(true)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://api/x', method: 'GET' } })
    sim.emitMessage('Network.responseReceived', { requestId: 'r1', response: { status: 200 } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'r1' })
    await flushMicrotasks()

    // Native path used; console fallback NOT used.
    expect(svc.exec).not.toHaveBeenCalled()
    expect(dt.exec).toHaveBeenCalled()
    const dispatched = dt.exec.mock.calls.flatMap((c) => decodeDispatched(String(c[0])))
    const methods = dispatched.map((d) => d.method)
    expect(methods).toContain('Network.requestWillBeSent')
    expect(methods).toContain('Network.responseReceived')
    expect(methods).toContain('Network.loadingFinished')
    // requestId rewritten in the forwarded payload.
    const rws = dispatched.find((d) => d.method === 'Network.requestWillBeSent')!
    expect((rws.params as { requestId: string }).requestId).toMatch(/^dimina:sim:/)
  })

  it('holds the queue while the MAIN frame is loading even when the coarse isLoading reads false', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const dt = makeDevtoolsWc(true, () => false)
    // Electron's internal executeJavaScript gate is isLoadingMainFrame, not
    // isLoading — the flush must consult the same predicate or every dispatch
    // during the divergence window queues one did-stop-loading waiter.
    Object.assign(dt.wc, { isLoadingMainFrame: () => true })
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    try {
      fwd.setDevtoolsHost(dt.wc)
      fwd.attachSimulator(sim.wc)

      sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://api/x', method: 'GET' } })
      await flushMicrotasks()
      expect(dt.exec).not.toHaveBeenCalled()
    } finally {
      // isLoadingMainFrame never flips back to false, so without dispose() this
      // test's real ready-retry timer keeps re-arming past the test's end and
      // can get adopted by a LATER test's vi.useFakeTimers() (which only
      // intercepts new timer calls, not this already-scheduled real one) —
      // the real cause of the CI-only flake in the ready-timeout test below.
      void fwd.dispose()
    }
  })

  it('holds the queue while the front-end is loading — no executeJavaScript per event, delivery resumes post-load', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    let loading = true
    const dt = makeDevtoolsWc(true, () => loading)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachSimulator(sim.wc)

    // A relaunch-style burst against a loading front-end: every dispatch would
    // queue one did-stop-loading waiter on the wc emitter — the flush must not
    // call executeJavaScript at all until the load ends.
    for (let i = 0; i < 5; i++) {
      sim.emitMessage('Network.requestWillBeSent', { requestId: `r${i}`, request: { url: `https://api/${i}`, method: 'GET' } })
    }
    await flushMicrotasks()
    expect(dt.exec).not.toHaveBeenCalled()

    loading = false
    sim.emitMessage('Network.requestWillBeSent', { requestId: 'r-post', request: { url: 'https://api/post', method: 'GET' } })
    await flushMicrotasks()
    // The held burst is preserved (bounded queue) and delivered after load.
    const dispatched = dt.exec.mock.calls.flatMap((c) => decodeDispatched(String(c[0])))
    const urls = dispatched.map((d) => (d.params as { request?: { url?: string } }).request?.url)
    expect(urls).toContain('https://api/0')
    expect(urls).toContain('https://api/4')
    expect(urls).toContain('https://api/post')
  })

  it('does NOT forward dataReceived (二期 deferred)', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const dt = makeDevtoolsWc(true)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'x', method: 'GET' } })
    sim.emitMessage('Network.dataReceived', { requestId: 'r1', dataLength: 10 })
    await flushMicrotasks()

    const dispatched = dt.exec.mock.calls.flatMap((c) => decodeDispatched(String(c[0])))
    expect(dispatched.map((d) => d.method)).not.toContain('Network.dataReceived')
  })

  it('batches multiple events into a single executeJavaScript call', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const dt = makeDevtoolsWc(true)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachSimulator(sim.wc)

    // Three synchronous events should coalesce into one microtask flush.
    sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'a', method: 'GET' } })
    sim.emitMessage('Network.responseReceived', { requestId: 'r1', response: { status: 200 } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'r1' })
    await flushMicrotasks()

    expect(dt.exec).toHaveBeenCalledTimes(1)
    expect(decodeDispatched(String(dt.exec.mock.calls[0]![0])).length).toBe(3)
  })

  it('falls back to the console line when no DevTools host is set', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.attachSimulator(sim.wc) // no setDevtoolsHost

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://api/x', method: 'GET' } })
    sim.emitMessage('Network.responseReceived', { requestId: 'r1', response: { status: 200 } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'r1' })
    await flushMicrotasks()

    // Console fallback fired (one [网络] line); no DevTools host to dispatch to.
    expect(svc.exec).toHaveBeenCalledTimes(1)
    expect(String(svc.exec.mock.calls[0]![0])).toContain('[网络]')
  })

  it('re-queues and retries when the front-end API is not ready yet', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    // API reports not-ready (false): the dispatch script returns false.
    const dt = makeDevtoolsWc(false)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    try {
      fwd.setDevtoolsHost(dt.wc)
      fwd.attachSimulator(sim.wc)

      sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'x', method: 'GET' } })
      await flushMicrotasks()

      // It attempted the native dispatch (API said not-ready) and did NOT fall to
      // the console for a non-terminal event — it keeps the queue for retry.
      expect(dt.exec).toHaveBeenCalled()
      expect(svc.exec).not.toHaveBeenCalled()
    } finally {
      // The API never reports ready, so without dispose() this test's real
      // ready-retry timer leaks past the test's end — see the same-shaped
      // comment on the 'holds the queue while the MAIN frame is loading' test.
      void fwd.dispose()
    }
  })

  it('clears the DevTools host on setDevtoolsHost(null), reverting to console', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const dt = makeDevtoolsWc(true)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachSimulator(sim.wc)
    fwd.setDevtoolsHost(null)

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'x', method: 'GET' } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'r1' })
    await flushMicrotasks()

    // No host → completion uses the console fallback.
    expect(svc.exec).toHaveBeenCalledTimes(1)
  })
})

// ── sink state machine, orphan-protection, chunk, batch ──────────────────────

describe('createNetworkForwarder — sink state machine (no double-display)', () => {
  it('MAJOR 1: a completion never shows in BOTH console and Network', async () => {
    vi.useFakeTimers()
    try {
      const sim = makeSimWc()
      const svc = makeServiceWc()
      const dt = makeDevtoolsWc(true)
      const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
      fwd.setDevtoolsHost(dt.wc)
      fwd.attachSimulator(sim.wc)

      // Complete a request: native (ready) renders it.
      sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'a', method: 'GET' } })
      sim.emitMessage('Network.loadingFinished', { requestId: 'r1' })
      await vi.runAllTimersAsync()

      // Native used, console suppressed — the request shows exactly once.
      expect(dt.exec).toHaveBeenCalled()
      expect(svc.exec).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('MAJOR 1: ready-timeout degrades a never-ready host to console exactly once', async () => {
    vi.useFakeTimers()
    try {
      const sim = makeSimWc()
      const svc = makeServiceWc()
      // API never becomes ready (always returns false).
      const dt = makeDevtoolsWc(false)
      const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
      fwd.setDevtoolsHost(dt.wc)
      fwd.attachSimulator(sim.wc)

      sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'a', method: 'GET' } })
      sim.emitMessage('Network.loadingFinished', { requestId: 'r1' })

      // Before the timeout: undecided → buffered, NEITHER sink has fired.
      await flushMicrotasks()
      expect(svc.exec).not.toHaveBeenCalled()

      // Past the ready-timeout: degrade → the buffered completion flushes to the
      // console sink exactly once (no native double).
      await vi.advanceTimersByTimeAsync(6000)
      expect(svc.exec).toHaveBeenCalledTimes(1)
      expect(String(svc.exec.mock.calls[0]![0])).toContain('[网络]')

      // After degrade, further events go straight to console (no requeue loop)
      // and the native queue stops growing.
      svc.exec.mockClear()
      sim.emitMessage('Network.requestWillBeSent', { requestId: 'r2', request: { url: 'b', method: 'GET' } })
      sim.emitMessage('Network.loadingFinished', { requestId: 'r2' })
      await vi.runAllTimersAsync()
      expect(svc.exec).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('MAJOR 1: switching to a second never-ready host restarts its own ready-timeout window', async () => {
    vi.useFakeTimers()
    let fwd: ReturnType<typeof createNetworkForwarder> | undefined
    try {
      const sim = makeSimWc()
      const svc = makeServiceWc()
      // Neither host ever reports its DevTools API as ready.
      const hostA = makeDevtoolsWc(false)
      const hostB = makeDevtoolsWc(false)
      fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
      // attachSimulator BEFORE setDevtoolsHost: attachSimulator internally calls
      // detachSimulator(), which resets the sink state machine to 'idle'. Calling
      // it between the two setDevtoolsHost() calls below would reset the probing
      // state and hide the exact race this test targets — the host switch below
      // must land while sink is still 'probing' from hostA.
      fwd.attachSimulator(sim.wc)
      fwd.setDevtoolsHost(hostA.wc)

      // Still inside hostA's probing window (< 5000ms) — no degrade yet.
      await vi.advanceTimersByTimeAsync(1000)
      expect(svc.exec).not.toHaveBeenCalled()

      // Switch hosts before hostA's ready-timeout elapses. hostB must get its
      // OWN fresh probing window — it must not inherit/skip hostA's expiry
      // and get stuck probing forever.
      fwd.setDevtoolsHost(hostB.wc)

      sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'a', method: 'GET' } })
      sim.emitMessage('Network.loadingFinished', { requestId: 'r1' })

      // Past hostB's own 5000ms ready-timeout window (measured from the
      // switch): the completion must degrade to the console sink.
      await vi.advanceTimersByTimeAsync(6000)
      expect(svc.exec).toHaveBeenCalledTimes(1)
      expect(String(svc.exec.mock.calls[0]![0])).toContain('[网络]')
    } finally {
      void fwd?.dispose()
      vi.useRealTimers()
    }
  })

  it('MAJOR 1: a request queued while no host appears ONLY natively after host set (no console dup)', async () => {
    vi.useFakeTimers()
    try {
      const sim = makeSimWc()
      const svc = makeServiceWc()
      const dt = makeDevtoolsWc(true)
      const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
      fwd.attachSimulator(sim.wc) // no host yet

      // Completes while idle → console sink owns it.
      sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'a', method: 'GET' } })
      sim.emitMessage('Network.loadingFinished', { requestId: 'r1' })
      await flushMicrotasks()
      expect(svc.exec).toHaveBeenCalledTimes(1) // console owned it

      // Now a host appears. The OLD (idle) request must NOT be replayed natively
      // (it would double-display). Only NEW events go native.
      fwd.setDevtoolsHost(dt.wc)
      await vi.runAllTimersAsync()
      const replayed = dt.exec.mock.calls.flatMap((c) => decodeDispatched(String(c[0])))
      expect(replayed.find((d) => (d.params as { requestId?: string }).requestId?.includes(':r1'))).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createNetworkForwarder — requestId orphan protection (MAJOR 3)', () => {
  it('keeps an active request mapping stable across a long in-flight gap', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const dt = makeDevtoolsWc(true)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'a', method: 'GET' } })
    // ...many OTHER requests churn through (would LRU-evict r1 under the old code)
    for (let i = 0; i < 1500; i++) {
      sim.emitMessage('Network.requestWillBeSent', { requestId: `x${i}`, request: { url: 'u', method: 'GET' } })
      sim.emitMessage('Network.loadingFinished', { requestId: `x${i}` })
    }
    // r1 finally completes: its virtual id must match its opener (no orphan).
    sim.emitMessage('Network.loadingFinished', { requestId: 'r1' })
    await flushMicrotasks()

    const dispatched = dt.exec.mock.calls.flatMap((c) => decodeDispatched(String(c[0])))
    const opener = dispatched.find((d) =>
      d.method === 'Network.requestWillBeSent'
      && (d.params as { requestId: string }).requestId.endsWith(':r1'))!
    const finish = dispatched.find((d) =>
      d.method === 'Network.loadingFinished'
      && (d.params as { requestId: string }).requestId.endsWith(':r1'))!
    expect((opener.params as { requestId: string }).requestId)
      .toBe((finish.params as { requestId: string }).requestId)
  })
})

describe('createNetworkForwarder — chunked dispatch (MAJOR 4)', () => {
  it('subsequent chunks call dispatchMessageChunk WITHOUT a second argument', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const dt = makeDevtoolsWc(true)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachSimulator(sim.wc)

    // A single oversized message (>1MB) forces the chunked transport.
    const hugeUrl = 'https://big/' + 'a'.repeat(1_200_000)
    sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: hugeUrl, method: 'GET' } })
    await flushMicrotasks()

    const chunkScript = dt.exec.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('dispatchMessageChunk'))
    expect(chunkScript).toBeDefined()
    // First chunk passes (chunk, totalSize); continuation chunks pass (chunk) only.
    expect(chunkScript!).toContain('dispatchMessageChunk(cs[i], ')
    expect(chunkScript!).toMatch(/dispatchMessageChunk\(cs\[i\]\)/)
    // The buggy `, 0)` continuation form must NOT appear.
    expect(chunkScript!).not.toContain('i===0?')
  })
})

describe('createNetworkForwarder — batch size cap (MAJOR 5)', () => {
  it('splits a large run of messages across multiple executeJavaScript calls', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const dt = makeDevtoolsWc(true)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachSimulator(sim.wc)

    // Many sizeable (but individually < single-dispatch cap) messages: their
    // combined size exceeds the per-batch char cap, forcing >1 flush.
    const url = 'https://api/' + 'p'.repeat(20_000) // ~20KB each
    for (let i = 0; i < 60; i++) {
      sim.emitMessage('Network.requestWillBeSent', { requestId: `r${i}`, request: { url, method: 'GET' } })
    }
    await flushMicrotasks()

    expect(dt.exec.mock.calls.length).toBeGreaterThan(1)
    // No single executeJavaScript script is absurdly large.
    for (const c of dt.exec.mock.calls) {
      expect(String(c[0]).length).toBeLessThan(2_000_000)
    }
    // All 60 openers still got dispatched (split, not dropped).
    const dispatched = dt.exec.mock.calls.flatMap((c) => decodeDispatched(String(c[0])))
    expect(dispatched.filter((d) => d.method === 'Network.requestWillBeSent').length).toBe(60)
  })
})

describe('createNetworkForwarder — connection-registry teardown', () => {
  /**
   * A simulator wc fake with the surface a real ConnectionRegistry needs: a
   * stable `id`, a real `once('destroyed')` emitter (the registry arms the
   * terminal hook there), plus the debugger surface the forwarder uses.
   */
  function makeRegistrySimWc(id: number) {
    let attached = false
    const dbgListeners = new Map<string, Set<(...a: unknown[]) => void>>()
    const destroyedListeners = new Set<() => void>()
    const dbg = {
      isAttached: () => attached,
      attach: vi.fn(() => { attached = true }),
      detach: vi.fn(() => { attached = false }),
      sendCommand: vi.fn(() => Promise.resolve({})),
      on: (ev: string, fn: (...a: unknown[]) => void) => {
        if (!dbgListeners.has(ev)) dbgListeners.set(ev, new Set())
        dbgListeners.get(ev)!.add(fn)
      },
      removeListener: (ev: string, fn: (...a: unknown[]) => void) => { dbgListeners.get(ev)?.delete(fn) },
    }
    const wc = {
      id,
      isDestroyed: () => false,
      debugger: dbg,
      once: (ev: string, fn: () => void) => { if (ev === 'destroyed') destroyedListeners.add(fn) },
      removeListener: () => {},
    } as unknown as WebContents
    const emitMessage = (method: string, params: unknown) => {
      for (const fn of dbgListeners.get('message') ?? []) (fn as DbgListener)({}, method, params)
    }
    const emitDestroyed = () => { for (const fn of [...destroyedListeners]) fn() }
    return { wc, dbg, emitMessage, emitDestroyed }
  }

  it('owns the simulator destroyed-teardown via the registry; destroy resets state + de-registers the connection', async () => {
    const sim = makeRegistrySimWc(42)
    const svc = makeServiceWc()
    const connections = createConnectionRegistry()
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc, connections })

    fwd.attachSimulator(sim.wc)
    // Attaching acquires the connection and owns the teardown on it.
    expect(connections.get(42)).toBeDefined()
    expect(sim.dbg.attach).toHaveBeenCalledWith('1.3')

    // The destroyed event drives the registry, which fires the owned teardown:
    // it nulls simWc-if-matched and disposeAll's the attach disposables (removing
    // the debugger 'message'/'detach' listeners), and the connection closes +
    // de-registers.
    sim.emitDestroyed()
    await flushMicrotasks()

    // Connection de-registered (its terminal hook fired and closed it).
    expect(connections.get(42)).toBeUndefined()

    // State reset: the debugger listeners were removed, so events from the old
    // (now-dead) sim no longer reach any sink.
    svc.exec.mockClear()
    sim.emitMessage('Network.requestWillBeSent', { requestId: '1', request: { url: 'https://x', method: 'GET' } })
    sim.emitMessage('Network.loadingFinished', { requestId: '1' })
    await flushMicrotasks()
    expect(svc.exec).not.toHaveBeenCalled()

    // Idempotent: a redundant destroy + detach must not throw.
    expect(() => { sim.emitDestroyed(); fwd.detachSimulator() }).not.toThrow()
  })
})

describe('createNetworkForwarder — host-destroyed cleanup (MINOR)', () => {
  it('host wc destroyed reverts to the console sink (no view-manager involvement)', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const dt = makeDevtoolsWc(true)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachSimulator(sim.wc)

    // Simulate the host wc being destroyed (its 'destroyed' event fires).
    dt.emitDestroyed()

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'a', method: 'GET' } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'r1' })
    await flushMicrotasks()

    // Host gone → completion uses the console fallback.
    expect(svc.exec).toHaveBeenCalledTimes(1)
  })
})

// ── response-body prefetch (fixes "Failed to load response data" in the panel) ──
//
// The DevTools front-end asks the attached backend for a completed request's
// body via Network.getResponseBody({requestId: <virtual id>}). No backend
// knows that virtual id, so a naive forward 404s. The forwarder instead
// prefetches the body from the simulator debugger — using the RAW id — the
// moment the request finishes, and answers the panel's later lookup from its
// own cache via `bodies`.

describe('createNetworkForwarder — response body prefetch', () => {
  it('prefetches the response body from the debugger using the RAW request id on loadingFinished', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const dt = makeDevtoolsWc(true)
    sim.sendCommand.mockImplementation((method: string) =>
      method === 'Network.getResponseBody'
        ? Promise.resolve({ body: 'hello world', base64Encoded: false })
        : Promise.resolve({}))
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://api/x', method: 'GET' } })
    sim.emitMessage('Network.responseReceived', { requestId: 'r1', response: { status: 200 } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'r1' })
    await flushMicrotasks()

    // The debugger is asked with the RAW id, never the rewritten virtual one.
    expect(sim.sendCommand).toHaveBeenCalledWith('Network.getResponseBody', { requestId: 'r1' })

    const dispatched = decodeDispatched(String(dt.exec.mock.calls[0]![0]))
    const opener = dispatched.find((d) => d.method === 'Network.requestWillBeSent')!
    const virtualId = (opener.params as { requestId: string }).requestId
    expect(virtualId.startsWith(VIRTUAL_REQUEST_ID_PREFIX)).toBe(true)

    await expect(fwd.bodies.getResponseBody(virtualId)).resolves.toEqual({ body: 'hello world', base64Encoded: false })
  })

  it('resolves getResponseBody only after the debugger prefetch settles (no race with the panel click)', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const dt = makeDevtoolsWc(true)
    let resolveBody!: (v: unknown) => void
    sim.sendCommand.mockImplementation((method: string) => {
      if (method === 'Network.getResponseBody') return new Promise((res) => { resolveBody = res })
      return Promise.resolve({})
    })
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://api/x', method: 'GET' } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'r1' })
    await flushMicrotasks()

    const dispatched = decodeDispatched(String(dt.exec.mock.calls[0]![0]))
    const virtualId = (dispatched.find((d) => d.method === 'Network.requestWillBeSent')!
      .params as { requestId: string }).requestId

    let resolved: unknown
    const pending = fwd.bodies.getResponseBody(virtualId).then((v) => { resolved = v })
    await flushMicrotasks()
    expect(resolved).toBeUndefined() // the panel click must wait on the real debugger round-trip

    resolveBody({ body: 'late', base64Encoded: false })
    await pending
    expect(resolved).toEqual({ body: 'late', base64Encoded: false })
  })

  it('rejects getResponseBody for a virtual id it never saw ("Failed to load response data")', async () => {
    const svc = makeServiceWc()
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })

    await expect(fwd.bodies.getResponseBody(`${VIRTUAL_REQUEST_ID_PREFIX}E1:1:ghost`))
      .rejects.toThrow('No resource with given identifier found')
  })

  it('rejects the body lookup with the standard not-found message when the debugger prefetch itself fails', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const dt = makeDevtoolsWc(true)
    sim.sendCommand.mockImplementation((method: string) =>
      method === 'Network.getResponseBody'
        ? Promise.reject(new Error('Target closed'))
        : Promise.resolve({}))
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://api/x', method: 'GET' } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'r1' })
    await flushMicrotasks()

    const dispatched = decodeDispatched(String(dt.exec.mock.calls[0]![0]))
    const virtualId = (dispatched.find((d) => d.method === 'Network.requestWillBeSent')!
      .params as { requestId: string }).requestId

    await expect(fwd.bodies.getResponseBody(virtualId)).rejects.toThrow('No resource with given identifier found')
  })

  it('does not prefetch the body when there is no devtools host to serve the panel', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.attachSimulator(sim.wc) // no setDevtoolsHost

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://api/x', method: 'GET' } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'r1' })
    await flushMicrotasks()

    const bodyCalls = sim.sendCommand.mock.calls.filter((c) => c[0] === 'Network.getResponseBody')
    expect(bodyCalls.length).toBe(0)
  })

  it('prefetches POST data via the debugger when the request signals hasPostData, keyed by the virtual id', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const dt = makeDevtoolsWc(true)
    sim.sendCommand.mockImplementation((method: string) =>
      method === 'Network.getRequestPostData'
        ? Promise.resolve({ postData: 'a=1&b=2' })
        : Promise.resolve({}))
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', {
      requestId: 'r1', request: { url: 'https://api/x', method: 'POST', hasPostData: true },
    })
    sim.emitMessage('Network.loadingFinished', { requestId: 'r1' })
    await flushMicrotasks()

    expect(sim.sendCommand).toHaveBeenCalledWith('Network.getRequestPostData', { requestId: 'r1' })

    const dispatched = decodeDispatched(String(dt.exec.mock.calls[0]![0]))
    const virtualId = (dispatched.find((d) => d.method === 'Network.requestWillBeSent')!
      .params as { requestId: string }).requestId
    await expect(fwd.bodies.getRequestPostData(virtualId)).resolves.toEqual({ postData: 'a=1&b=2' })
  })

  it('does not prefetch POST data for a request that never signaled hasPostData', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const dt = makeDevtoolsWc(true)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://api/x', method: 'GET' } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'r1' })
    await flushMicrotasks()

    const postCalls = sim.sendCommand.mock.calls.filter((c) => c[0] === 'Network.getRequestPostData')
    expect(postCalls.length).toBe(0)
  })

  it('keeps a prefetched body cached across detachSimulator (the virtual id is not reused, so it never collides)', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const dt = makeDevtoolsWc(true)
    sim.sendCommand.mockImplementation((method: string) =>
      method === 'Network.getResponseBody'
        ? Promise.resolve({ body: 'kept', base64Encoded: false })
        : Promise.resolve({}))
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://api/x', method: 'GET' } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'r1' })
    await flushMicrotasks()

    const dispatched = decodeDispatched(String(dt.exec.mock.calls[0]![0]))
    const virtualId = (dispatched.find((d) => d.method === 'Network.requestWillBeSent')!
      .params as { requestId: string }).requestId

    fwd.detachSimulator()

    await expect(fwd.bodies.getResponseBody(virtualId)).resolves.toEqual({ body: 'kept', base64Encoded: false })
  })

  it('dispose() rejects every subsequent body lookup', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const dt = makeDevtoolsWc(true)
    sim.sendCommand.mockImplementation((method: string) =>
      method === 'Network.getResponseBody'
        ? Promise.resolve({ body: 'x', base64Encoded: false })
        : Promise.resolve({}))
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://api/x', method: 'GET' } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'r1' })
    await flushMicrotasks()

    const dispatched = decodeDispatched(String(dt.exec.mock.calls[0]![0]))
    const virtualId = (dispatched.find((d) => d.method === 'Network.requestWillBeSent')!
      .params as { requestId: string }).requestId

    await fwd.dispose()

    await expect(fwd.bodies.getResponseBody(virtualId)).rejects.toThrow('No resource with given identifier found')
  })
})

// ── prefetch admission control ───────────────────────────────────────────────
//
// PrefetchCache bounds SETTLED entries only — a pending prefetch counts 0 size
// and is exempt from eviction (see body-cache.ts), so a page completing many
// large requests at once (e.g. render-guest images loading concurrently) can
// have an unbounded number of full-body debugger round-trips in flight before
// any single one is ever rejected for being oversized. Admission control adds
// two independent guards in front of the existing unconditional prefetch:
//  - a cap on how many prefetches may be PENDING at once across the whole
//    forwarder (simulator + every render-guest share it, not one cap each);
//  - a preflight against loadingFinished's own encodedDataLength, skipping a
//    request outright when it is already known to exceed the cache's
//    per-entry limit, without ever starting the debugger round-trip.
// Either guard skipping a request leaves its virtual id "never primed": a
// panel lookup on it rejects with the same not-found message an unknown CDP
// requestId would produce.

describe('createNetworkForwarder — prefetch admission control', () => {
  /** Raw requestId -> was Network.getResponseBody ever invoked for it. */
  function wasPrefetched(sim: ReturnType<typeof makeSimWc>, rawId: string): boolean {
    return sim.sendCommand.mock.calls.some(
      (c) => c[0] === 'Network.getResponseBody' && (c[1] as { requestId?: string } | undefined)?.requestId === rawId,
    )
  }

  /** Locate the virtual (namespaced) requestId dispatched for a raw one. */
  function virtualIdFor(dt: ReturnType<typeof makeDevtoolsWc>, rawId: string): string {
    const dispatched = dt.exec.mock.calls.flatMap((c) => decodeDispatched(String(c[0])))
    const opener = dispatched.find(
      (d) => d.method === 'Network.requestWillBeSent' && (d.params as { requestId: string }).requestId.endsWith(`:${rawId}`),
    )!
    return (opener.params as { requestId: string }).requestId
  }

  /**
   * Feeds requestWillBeSent+loadingFinished pairs — each against a debugger
   * whose Network.getResponseBody NEVER resolves (every call's resolver is
   * captured instead) — one raw id at a time, until one of them fails to
   * trigger a prefetch call, i.e. until the concurrency cap is hit. Fails the
   * caller outright (via a null cappedRawId) if all 200 requests got
   * prefetched, meaning no cap exists at all.
   */
  async function feedUntilCapped() {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const dt = makeDevtoolsWc(true)
    const resolvers: Array<(v: unknown) => void> = []
    sim.sendCommand.mockImplementation((method: string) => {
      if (method === 'Network.getResponseBody') return new Promise((res) => { resolvers.push(res) })
      return Promise.resolve({})
    })
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachSimulator(sim.wc)

    const TOTAL = 200
    let cappedRawId: string | null = null
    for (let i = 0; i < TOTAL; i++) {
      const rawId = `cap-${i}`
      sim.emitMessage('Network.requestWillBeSent', { requestId: rawId, request: { url: `https://img/${i}.png`, method: 'GET' } })
      sim.emitMessage('Network.loadingFinished', { requestId: rawId })
      await flushMicrotasks()
      if (!wasPrefetched(sim, rawId)) { cappedRawId = rawId; break }
    }
    return { sim, svc, dt, fwd, resolvers, cappedRawId, TOTAL }
  }

  it('skips the debugger prefetch once too many prefetches are pending concurrently', async () => {
    const { cappedRawId, TOTAL } = await feedUntilCapped()

    // A bound was actually hit well before exhausting the run — not "never".
    expect(cappedRawId).not.toBeNull()
    // The bound is a real, small limit, not a coincidental late failure.
    const cappedIndex = Number(cappedRawId!.slice('cap-'.length))
    expect(cappedIndex).toBeLessThan(TOTAL / 2)
  })

  it('keeps skipping further completions while the cap stays saturated', async () => {
    const { sim } = await feedUntilCapped()

    for (let i = 0; i < 5; i++) {
      const rawId = `cap-extra-${i}`
      sim.emitMessage('Network.requestWillBeSent', { requestId: rawId, request: { url: `https://img/extra-${i}.png`, method: 'GET' } })
      sim.emitMessage('Network.loadingFinished', { requestId: rawId })
      await flushMicrotasks()
      expect(wasPrefetched(sim, rawId)).toBe(false)
    }
  })

  it('resumes prefetching once a pending prefetch resolves and frees a slot', async () => {
    const { sim, resolvers } = await feedUntilCapped()

    resolvers[0]!({ body: 'freed', base64Encoded: false })
    await flushMicrotasks()

    const rawId = 'cap-after-free'
    sim.emitMessage('Network.requestWillBeSent', { requestId: rawId, request: { url: 'https://img/after-free.png', method: 'GET' } })
    sim.emitMessage('Network.loadingFinished', { requestId: rawId })
    await flushMicrotasks()

    expect(wasPrefetched(sim, rawId)).toBe(true)
  })

  it('rejects getResponseBody for a request skipped by the concurrency cap ("Failed to load response data")', async () => {
    const { dt, fwd, cappedRawId } = await feedUntilCapped()

    const virtualId = virtualIdFor(dt, cappedRawId!)
    await expect(fwd.bodies.getResponseBody(virtualId)).rejects.toThrow('No resource with given identifier found')
  })

  it("does not call Network.getResponseBody when loadingFinished's encodedDataLength exceeds the cache's per-entry limit", async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const dt = makeDevtoolsWc(true)
    sim.sendCommand.mockImplementation((method: string) =>
      method === 'Network.getResponseBody'
        ? Promise.resolve({ body: 'irrelevant', base64Encoded: false })
        : Promise.resolve({}))
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'oversized', request: { url: 'https://img/huge.png', method: 'GET' } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'oversized', encodedDataLength: DEFAULT_PER_ENTRY_MAX_CHARS + 1000 })
    await flushMicrotasks()

    expect(wasPrefetched(sim, 'oversized')).toBe(false)

    const virtualId = virtualIdFor(dt, 'oversized')
    await expect(fwd.bodies.getResponseBody(virtualId)).rejects.toThrow('No resource with given identifier found')
  })

  it('still prefetches when encodedDataLength is well within the per-entry limit', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const dt = makeDevtoolsWc(true)
    sim.sendCommand.mockImplementation((method: string) =>
      method === 'Network.getResponseBody'
        ? Promise.resolve({ body: 'small', base64Encoded: false })
        : Promise.resolve({}))
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'small', request: { url: 'https://img/small.png', method: 'GET' } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'small', encodedDataLength: 100 })
    await flushMicrotasks()

    expect(wasPrefetched(sim, 'small')).toBe(true)
  })
})

// ── render-host guest capture ────────────────────────────────────────────────
//
// The render-host `<webview>` guest (pageFrame.html) loads its own resources
// (images/fonts/page fetches) whose CDP Network events are invisible to the
// panel unless the forwarder also wires that wc. Its `wc.debugger` may already
// be attached (the safe-area service attaches it first, and Electron debugger
// attach is exclusive per wc) — attachRenderGuest must reuse an already-attached
// session (message listener + sendCommand only) rather than fight for exclusive
// ownership, and must only attach/detach its own session when none exists yet.

describe('createNetworkForwarder — render-host guest capture', () => {
  /**
   * A render-host guest wc fake: same debugger/message/destroyed surface as
   * makeSimWc/makeRegistrySimWc, but with a configurable INITIAL isAttached()
   * state — attachRenderGuest's session-reuse-vs-self-attach branch depends on
   * whether some other owner (safe-area) already holds the debugger.
   */
  // `id` defaults to a fixed non-zero value distinct from the other wc fakes'
  // default (`undefined`) in this file: `ConnectionRegistry.acquire()` keys its
  // connection map by `wc.id`, so any test combining a guest with another wc
  // (e.g. a devtools host) through a REAL `createConnectionRegistry()` needs
  // them to resolve to different connections — two fakes both defaulting to
  // `id: undefined` would silently collide onto the SAME connection object.
  function makeGuestWc(initiallyAttached: boolean, id = 7) {
    let attached = initiallyAttached
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    const destroyedListeners = new Set<() => void>()
    const sendCommand = vi.fn((_method: string, _params?: object) => Promise.resolve({}) as Promise<unknown>)
    const dbg = {
      isAttached: () => attached,
      attach: vi.fn(() => { attached = true }),
      detach: vi.fn(() => { attached = false }),
      sendCommand,
      on: (ev: string, fn: (...args: unknown[]) => void) => {
        if (!listeners.has(ev)) listeners.set(ev, new Set())
        listeners.get(ev)!.add(fn)
      },
      removeListener: (ev: string, fn: (...args: unknown[]) => void) => {
        listeners.get(ev)?.delete(fn)
      },
    }
    const wc = {
      id,
      isDestroyed: () => false,
      debugger: dbg,
      once: (ev: string, fn: () => void) => { if (ev === 'destroyed') destroyedListeners.add(fn) },
      removeListener: (ev: string, fn: () => void) => { if (ev === 'destroyed') destroyedListeners.delete(fn) },
    } as unknown as WebContents
    const emitMessage = (method: string, params: unknown) => {
      // A detached CDP session cannot deliver events — mirrors real Electron:
      // an externally-detached debugger simply stops emitting 'message'.
      if (!attached) return
      for (const fn of listeners.get('message') ?? []) (fn as DbgListener)({}, method, params)
    }
    const emitDestroyed = () => { for (const fn of [...destroyedListeners]) fn() }
    /** Simulate the debugger session being torn down by an owner OTHER than
     * network-forward itself (e.g. a real Chrome DevTools window attaching). */
    const emitDetach = () => {
      attached = false
      for (const fn of listeners.get('detach') ?? []) (fn as () => void)()
    }
    return { wc, dbg, sendCommand, emitMessage, emitDestroyed, emitDetach }
  }

  it('injects a render-guest event into the DevTools front-end with a rewritten (non-raw) virtual id', async () => {
    const guest = makeGuestWc(true)
    const dt = makeDevtoolsWc(true)
    const svc = makeServiceWc()
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachRenderGuest(guest.wc)

    guest.emitMessage('Network.requestWillBeSent', {
      requestId: 'g1', request: { url: 'https://img/x.png', method: 'GET' },
    })
    await flushMicrotasks()

    expect(dt.exec).toHaveBeenCalled()
    const dispatched = dt.exec.mock.calls.flatMap((c) => decodeDispatched(String(c[0])))
    const rws = dispatched.find((d) => d.method === 'Network.requestWillBeSent')!
    const virtualId = (rws.params as { requestId: string }).requestId
    expect(virtualId).not.toBe('g1')
    expect(virtualId.startsWith(VIRTUAL_REQUEST_ID_PREFIX)).toBe(true)
  })

  it('prefetches the response body from the GUEST debugger using its raw id on loadingFinished', async () => {
    const guest = makeGuestWc(true)
    guest.sendCommand.mockImplementation((method: string) =>
      method === 'Network.getResponseBody'
        ? Promise.resolve({ body: 'aW1nLWJ5dGVz', base64Encoded: true })
        : Promise.resolve({}))
    const dt = makeDevtoolsWc(true)
    const svc = makeServiceWc()
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachRenderGuest(guest.wc)

    guest.emitMessage('Network.requestWillBeSent', {
      requestId: 'g1', request: { url: 'https://img/x.png', method: 'GET' },
    })
    guest.emitMessage('Network.loadingFinished', { requestId: 'g1' })
    await flushMicrotasks()

    // Asked on the GUEST's own debugger, with the raw (unrewritten) id.
    expect(guest.sendCommand).toHaveBeenCalledWith('Network.getResponseBody', { requestId: 'g1' })

    const dispatched = dt.exec.mock.calls.flatMap((c) => decodeDispatched(String(c[0])))
    const virtualId = (dispatched.find((d) => d.method === 'Network.requestWillBeSent')!
      .params as { requestId: string }).requestId
    await expect(fwd.bodies.getResponseBody(virtualId))
      .resolves.toEqual({ body: 'aW1nLWJ5dGVz', base64Encoded: true })
  })

  it('keeps simulator and render-guest virtual ids in separate namespaces for the same raw request id', async () => {
    const sim = makeSimWc()
    const guest = makeGuestWc(true)
    const dt = makeDevtoolsWc(true)
    const svc = makeServiceWc()
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachSimulator(sim.wc)
    fwd.attachRenderGuest(guest.wc)

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://sim/x', method: 'GET' } })
    guest.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://guest/x', method: 'GET' } })
    await flushMicrotasks()

    const dispatched = dt.exec.mock.calls.flatMap((c) => decodeDispatched(String(c[0])))
    const opens = dispatched.filter((d) => d.method === 'Network.requestWillBeSent')
    const ids = opens.map((d) => (d.params as { requestId: string }).requestId)
    expect(ids.length).toBe(2)
    expect(new Set(ids).size).toBe(2)
  })

  it('reuses an already-attached guest debugger session (no attach, no detach on dispose)', async () => {
    const guest = makeGuestWc(true) // some other owner (safe-area) already attached it
    const dt = makeDevtoolsWc(true)
    const svc = makeServiceWc()
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)

    fwd.attachRenderGuest(guest.wc)
    expect(guest.dbg.attach).not.toHaveBeenCalled()

    await fwd.dispose()
    // Not our session to tear down — the other owner still needs it attached.
    expect(guest.dbg.detach).not.toHaveBeenCalled()
  })

  it('self-attaches when the guest debugger has no owner yet, and detaches its own session on dispose', async () => {
    const guest = makeGuestWc(false)
    const dt = makeDevtoolsWc(true)
    const svc = makeServiceWc()
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)

    fwd.attachRenderGuest(guest.wc)
    expect(guest.dbg.attach).toHaveBeenCalledWith('1.3')

    await fwd.dispose()
    expect(guest.dbg.detach).toHaveBeenCalled()
  })

  it('is idempotent per guest wc — calling attachRenderGuest twice registers only one listener', async () => {
    const guest = makeGuestWc(false)
    const dt = makeDevtoolsWc(true)
    const svc = makeServiceWc()
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)

    fwd.attachRenderGuest(guest.wc)
    fwd.attachRenderGuest(guest.wc)

    guest.emitMessage('Network.requestWillBeSent', {
      requestId: 'g1', request: { url: 'https://img/x.png', method: 'GET' },
    })
    await flushMicrotasks()

    const dispatched = dt.exec.mock.calls.flatMap((c) => decodeDispatched(String(c[0])))
    const opens = dispatched.filter((d) => d.method === 'Network.requestWillBeSent')
    expect(opens.length).toBe(1)
  })

  it('stops forwarding once the render-host guest wc is destroyed', async () => {
    const guest = makeGuestWc(false)
    const dt = makeDevtoolsWc(true)
    const svc = makeServiceWc()
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachRenderGuest(guest.wc)

    guest.emitDestroyed()
    dt.exec.mockClear()

    guest.emitMessage('Network.requestWillBeSent', {
      requestId: 'g2', request: { url: 'https://img/y.png', method: 'GET' },
    })
    guest.emitMessage('Network.loadingFinished', { requestId: 'g2' })
    await flushMicrotasks()

    expect(dt.exec).not.toHaveBeenCalled()
  })

  it('routes a completed render-guest request to the console fallback labeled source: "render" when there is no DevTools host', async () => {
    const guest = makeGuestWc(false)
    const svc = makeServiceWc()
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.attachRenderGuest(guest.wc) // no setDevtoolsHost, and bridge.getDevtoolsWc gives none either

    guest.emitMessage('Network.requestWillBeSent', {
      requestId: 'g1', request: { url: 'https://img/x.png', method: 'GET' },
    })
    guest.emitMessage('Network.responseReceived', { requestId: 'g1', response: { status: 200 } })
    guest.emitMessage('Network.loadingFinished', { requestId: 'g1' })
    await flushMicrotasks()

    expect(svc.exec).toHaveBeenCalledTimes(1)
    const script = String(svc.exec.mock.calls[0]![0])
    expect(script).toContain('[网络]')
    expect(script).toContain(JSON.stringify(JSON.stringify({
      source: 'render', url: 'https://img/x.png', method: 'GET', status: 200,
    })))
  })

  // dispose() returns registry.disposeAll(), an async LIFO teardown where only
  // the LAST-registered entry runs before the first `await` — everything else
  // (including guest cleanup) lands on a later microtask. A caller that fires
  // dispose() without awaiting it (every real call site) must still see guest
  // forwarding stop in the same tick, not one microtask later.
  it('stops forwarding a render-guest message immediately after dispose(), without awaiting the returned promise', async () => {
    const guest = makeGuestWc(false) // no other owner: attachRenderGuest self-attaches
    const dt = makeDevtoolsWc(true)
    const svc = makeServiceWc()
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachRenderGuest(guest.wc)

    void fwd.dispose() // never awaited — matches every real caller

    // The forwarder owned this guest's debugger session; dispose() must have
    // already detached it before returning, not on a later microtask.
    expect(guest.dbg.detach).toHaveBeenCalled()

    // Arrives in the SAME tick as dispose() — before any microtask runs.
    guest.emitMessage('Network.requestWillBeSent', {
      requestId: 'g-after-dispose', request: { url: 'https://img/after-dispose.png', method: 'GET' },
    })
    guest.emitMessage('Network.loadingFinished', { requestId: 'g-after-dispose' })
    await flushMicrotasks()

    expect(dt.exec).not.toHaveBeenCalled()
  })

  // The current guest-destroy teardown rides Connection.own(onDestroyed): its
  // segment disposal is LIFO, so onDestroyed only runs synchronously with
  // close() when it happens to be the LAST resource registered on that
  // connection. elements-forward/index.ts instead uses
  // connections.acquire(wc).on('closed', cb) — Connection.close() calls
  // emit('closed') unconditionally and synchronously, independent of segment
  // registration order.
  it("registers guest destroy-teardown via connections.acquire(wc).on('closed', ...), not own()", () => {
    const guest = makeGuestWc(false)
    const dt = makeDevtoolsWc(true)
    const svc = makeServiceWc()
    const ownSpy = vi.fn((_d: Disposable | (() => void)): Disposable => ({ dispose: () => {} }))
    const onSpy = vi.fn((_ev: 'reset' | 'closed', _cb: () => void): Disposable => ({ dispose: () => {} }))
    const guestConnection: Connection = {
      id: guest.wc.id, webContents: guest.wc, alive: true, own: ownSpy, on: onSpy,
    }
    // A per-wc fake registry — mirrors the real ConnectionRegistry keying
    // connections by wc identity. A single shared fake object here would wrongly
    // attribute setDevtoolsHost's OWN (pre-existing, unrelated) `.own()` call for
    // the devtools-HOST wc to this spy too, since that call happens before
    // attachRenderGuest and would otherwise land on the same fake connection.
    const otherOwnSpy = vi.fn((_d: Disposable | (() => void)): Disposable => ({ dispose: () => {} }))
    const devtoolsHostConnection: Connection = {
      id: dt.wc.id, webContents: dt.wc, alive: true, own: otherOwnSpy, on: vi.fn(),
    }
    const fakeConnections: ConnectionRegistry = {
      acquire: (wc) => (wc === guest.wc ? guestConnection : devtoolsHostConnection),
      get: () => undefined,
      all: () => [],
      reset: () => {},
    }
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc, connections: fakeConnections })
    fwd.setDevtoolsHost(dt.wc)

    fwd.attachRenderGuest(guest.wc)

    expect(onSpy).toHaveBeenCalledWith('closed', expect.any(Function))
    expect(ownSpy).not.toHaveBeenCalled()
  })

  it('keeps guest cleanup synchronous with connection close even when another owner registers on the same connection afterward', async () => {
    const guest = makeGuestWc(false)
    const dt = makeDevtoolsWc(true)
    const svc = makeServiceWc()
    const connections = createConnectionRegistry()
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc, connections })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachRenderGuest(guest.wc)

    // A DIFFERENT feature (e.g. safe-area) owns a resource on the SAME
    // connection, registered AFTER network-forward's own teardown. Under
    // own()'s LIFO disposal this later registration runs first and defers
    // network-forward's cleanup by a microtask.
    connections.acquire(guest.wc).own(() => {})

    guest.emitDestroyed() // fires wc.once('destroyed') -> Connection.close()
    dt.exec.mockClear()

    // Arrives in the SAME tick as the destroy event.
    guest.emitMessage('Network.requestWillBeSent', {
      requestId: 'g-after-close', request: { url: 'https://img/after-close.png', method: 'GET' },
    })
    guest.emitMessage('Network.loadingFinished', { requestId: 'g-after-close' })
    await flushMicrotasks()

    expect(dt.exec).not.toHaveBeenCalled()
  })

  // attachSimulator resets its own `simWc` pointer on a debugger 'detach' event
  // so a later attachSimulator(sameWc) can re-attach. attachRenderGuest has no
  // equivalent: once wired, guestWired keeps the wc.id forever, so an external
  // detach (e.g. the user opening a real Chrome DevTools window against the
  // same target) permanently blocks re-attachment via the `guestWired.has()`
  // idempotency guard.
  it('recovers render-guest capture after the shared debugger session is externally detached', async () => {
    const guest = makeGuestWc(true) // already attached by another owner (safe-area)
    const dt = makeDevtoolsWc(true)
    const svc = makeServiceWc()
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachRenderGuest(guest.wc)

    guest.emitMessage('Network.requestWillBeSent', {
      requestId: 'g1', request: { url: 'https://img/x.png', method: 'GET' },
    })
    await flushMicrotasks()
    expect(dt.exec).toHaveBeenCalled()
    dt.exec.mockClear()

    // Something outside network-forward detaches the shared debugger session.
    guest.emitDetach()

    // Re-attaching the same wc must fully re-wire capture, not be swallowed by
    // the per-wc idempotency guard.
    fwd.attachRenderGuest(guest.wc)

    guest.emitMessage('Network.requestWillBeSent', {
      requestId: 'g2', request: { url: 'https://img/y.png', method: 'GET' },
    })
    await flushMicrotasks()

    expect(dt.exec).toHaveBeenCalled()
  })
})
