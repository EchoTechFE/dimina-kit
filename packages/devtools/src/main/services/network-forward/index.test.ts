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
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'
import {
  createNetworkForwarder,
  rewriteRequestId,
  RequestIdNamespace,
  REWRITE_REQUEST_ID_METHODS,
  FORWARDED_METHODS,
} from './index.js'

/** Run all pending microtasks (the native dispatch path is microtask-flushed). */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

type DbgListener = (event: unknown, method: string, params: unknown) => void

function makeSimWc() {
  let attached = false
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const sendCommand = vi.fn(() => Promise.resolve({}))
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
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://api/x', method: 'GET' } })
    await flushMicrotasks()
    expect(dt.exec).not.toHaveBeenCalled()
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
    fwd.setDevtoolsHost(dt.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'x', method: 'GET' } })
    await flushMicrotasks()

    // It attempted the native dispatch (API said not-ready) and did NOT fall to
    // the console for a non-terminal event — it keeps the queue for retry.
    expect(dt.exec).toHaveBeenCalled()
    expect(svc.exec).not.toHaveBeenCalled()
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
