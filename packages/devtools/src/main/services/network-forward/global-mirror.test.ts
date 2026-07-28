/**
 * Behavior tests for the Phase 2 "global mirror" sink on `NetworkForwarder`:
 * `setGlobalDevtoolsHost(wc)`.
 *
 * Unlike the existing user-facing sink (`setDevtoolsHost`, covered exhaustively
 * in `index.test.ts`), the global mirror:
 *   - has NO probing/ready/degraded state machine and NO console fallback —
 *     every FORWARDED_METHODS event is mirrored raw whenever a host is set,
 *     regardless of what state the user-facing sink is in;
 *   - is NOT filtered by `isUserFacingRequest` — internal/framework resource
 *     requests that the user-facing sink now hides still show up here;
 *   - coexists with a new user-facing-sink behavior change this same phase
 *     introduces: the user-facing sink now filters OUT internal resource
 *     requests (`isUserFacingRequest(url) === false`) instead of showing
 *     everything.
 *
 * These are new scenarios, kept in a separate file from the large, historically
 * flaky `index.test.ts` on purpose — see that file's own header for why it
 * stays untouched. Bug-fix-round regression coverage for this same sink lives
 * in `global-mirror-bugfixes.test.ts` (split out to keep both files under the
 * repo's 500-line-per-file ratchet).
 */
import { describe, expect, it, vi } from 'vitest'
import { createNetworkForwarder } from './index.js'
import { allDispatched, flushMicrotasks, makeDevtoolsWc, makeServiceWc, makeSimWc } from './global-mirror-test-fixtures.js'

// ── scenario 1+2: the global mirror ignores the user-facing sink's state ────

describe('createNetworkForwarder — setGlobalDevtoolsHost mirrors regardless of user-sink state', () => {
  it('mirrors events into the global host while the user-facing sink is idle (no setDevtoolsHost ever called)', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const global = makeDevtoolsWc(true)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })

    expect(typeof (fwd as unknown as { setGlobalDevtoolsHost?: unknown }).setGlobalDevtoolsHost).toBe('function')
    fwd.setGlobalDevtoolsHost(global.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', { requestId: '1', request: { url: 'https://api.example.com/foo', method: 'GET' } })
    sim.emitMessage('Network.responseReceived', { requestId: '1', response: { status: 200 } })
    sim.emitMessage('Network.loadingFinished', { requestId: '1' })
    await flushMicrotasks()

    const methods = allDispatched(global.exec).map((d) => d.method)
    expect(methods).toContain('Network.requestWillBeSent')
    expect(methods).toContain('Network.responseReceived')
    expect(methods).toContain('Network.loadingFinished')
  })

  it('mirrors a loadingFailed event into the global host', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const global = makeDevtoolsWc(true)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setGlobalDevtoolsHost(global.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', { requestId: '9', request: { url: 'https://api.example.com/down', method: 'GET' } })
    sim.emitMessage('Network.loadingFailed', { requestId: '9', errorText: 'net::ERR_FAILED' })
    await flushMicrotasks()

    const methods = allDispatched(global.exec).map((d) => d.method)
    expect(methods).toContain('Network.loadingFailed')
  })

  it('mirrors events into the global host while the user-facing sink is degraded (never-ready host)', async () => {
    vi.useFakeTimers()
    const sim = makeSimWc()
    const svc = makeServiceWc()
    // User-facing host whose DevToolsAPI never reports ready → the user sink
    // will eventually degrade to the console fallback.
    const user = makeDevtoolsWc(false)
    const global = makeDevtoolsWc(true)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    try {
      fwd.setDevtoolsHost(user.wc)
      fwd.setGlobalDevtoolsHost(global.wc)
      fwd.attachSimulator(sim.wc)

      sim.emitMessage('Network.requestWillBeSent', { requestId: '1', request: { url: 'https://api.example.com/foo', method: 'GET' } })
      sim.emitMessage('Network.loadingFinished', { requestId: '1' })

      // Drive the user-facing sink's ready-timeout past its 5s deadline so it
      // degrades to console — the global mirror must be wholly unaffected by
      // this state transition on the OTHER sink.
      await vi.advanceTimersByTimeAsync(6000)

      const methods = allDispatched(global.exec).map((d) => d.method)
      expect(methods).toContain('Network.requestWillBeSent')
      expect(methods).toContain('Network.loadingFinished')
    } finally {
      await fwd.dispose()
      vi.useRealTimers()
    }
  })
})

// ── scenario 3+4: the user-facing sink now filters by isUserFacingRequest ───

describe('createNetworkForwarder — user-facing sink filters internal resources, global mirror does not', () => {
  it('hides an internal resource request (file://) from the user-facing sink but still mirrors it globally', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const user = makeDevtoolsWc(true)
    const global = makeDevtoolsWc(true)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(user.wc)
    fwd.setGlobalDevtoolsHost(global.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', {
      requestId: 'int-1', request: { url: 'file:///dist/render-host/pageFrame.html', method: 'GET' },
    })
    sim.emitMessage('Network.responseReceived', { requestId: 'int-1', response: { status: 200 } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'int-1' })
    await flushMicrotasks()

    // Entirely absent from the user-facing sink...
    const userDispatched = allDispatched(user.exec)
    const userRequestIds = userDispatched.map((d) => (d.params as { requestId?: string }).requestId)
    expect(userRequestIds.some((id) => typeof id === 'string' && id.includes('int-1'))).toBe(false)

    // ...but present in the global mirror.
    const globalDispatched = allDispatched(global.exec)
    const globalMethods = globalDispatched
      .filter((d) => (d.params as { requestId?: string }).requestId?.includes('int-1'))
      .map((d) => d.method)
    expect(globalMethods).toContain('Network.requestWillBeSent')
    expect(globalMethods).toContain('Network.responseReceived')
    expect(globalMethods).toContain('Network.loadingFinished')
  })

  it('still forwards an ordinary business request into the user-facing sink (regression: filtering must not swallow real traffic)', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const user = makeDevtoolsWc(true)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(user.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', {
      requestId: 'biz-1', request: { url: 'http://api.example.com/foo', method: 'GET' },
    })
    sim.emitMessage('Network.responseReceived', { requestId: 'biz-1', response: { status: 200 } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'biz-1' })
    await flushMicrotasks()

    const userDispatched = allDispatched(user.exec)
    const methods = userDispatched
      .filter((d) => (d.params as { requestId?: string }).requestId?.includes('biz-1'))
      .map((d) => d.method)
    expect(methods).toContain('Network.requestWillBeSent')
    expect(methods).toContain('Network.responseReceived')
    expect(methods).toContain('Network.loadingFinished')
  })
})

// ── scenario 5: setGlobalDevtoolsHost(null) stops mirroring ─────────────────

describe('createNetworkForwarder — setGlobalDevtoolsHost(null) stops the mirror', () => {
  it('stops forwarding to a global host once cleared with null', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const global = makeDevtoolsWc(true)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setGlobalDevtoolsHost(global.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'a', request: { url: 'https://api.example.com/a', method: 'GET' } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'a' })
    await flushMicrotasks()
    expect(global.exec).toHaveBeenCalled()

    global.exec.mockClear()
    fwd.setGlobalDevtoolsHost(null)

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'b', request: { url: 'https://api.example.com/b', method: 'GET' } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'b' })
    await flushMicrotasks()

    expect(global.exec).not.toHaveBeenCalled()
  })
})

// ── scenario 6: classification is decided once per request, at requestWillBeSent ──

describe('createNetworkForwarder — user-facing classification is stable across a request\'s lifecycle', () => {
  it('classifies once at requestWillBeSent and keeps ALL later events (which carry no url) on the same sink, even interleaved with a different request', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const user = makeDevtoolsWc(true)
    const global = makeDevtoolsWc(true)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(user.wc)
    fwd.setGlobalDevtoolsHost(global.wc)
    fwd.attachSimulator(sim.wc)

    // Two requests in flight at once: 'internal' (framework resource, hidden
    // from the user sink) and 'business' (ordinary request, visible). Interleave
    // their lifecycle events — responseReceived/loadingFinished carry only a
    // requestId, never a url, so a correct implementation MUST remember the
    // requestWillBeSent-time classification per requestId rather than re-deriving
    // it (impossible) from later events.
    sim.emitMessage('Network.requestWillBeSent', {
      requestId: 'internal', request: { url: 'file:///dist/app.js', method: 'GET' },
    })
    sim.emitMessage('Network.requestWillBeSent', {
      requestId: 'business', request: { url: 'http://api.example.com/y', method: 'GET' },
    })
    sim.emitMessage('Network.responseReceived', { requestId: 'business', response: { status: 200 } })
    sim.emitMessage('Network.responseReceived', { requestId: 'internal', response: { status: 200 } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'internal' })
    sim.emitMessage('Network.loadingFinished', { requestId: 'business' })
    await flushMicrotasks()

    const userIds = new Set(
      allDispatched(user.exec).map((d) => (d.params as { requestId?: string }).requestId),
    )
    const userHasInternal = [...userIds].some((id) => typeof id === 'string' && id.includes('internal'))
    const userHasBusiness = [...userIds].some((id) => typeof id === 'string' && id.includes('business'))
    expect(userHasInternal).toBe(false)
    expect(userHasBusiness).toBe(true)

    // Every one of the 3 lifecycle events for 'business' reached the user sink
    // (not just requestWillBeSent — proving the later, url-less events followed
    // the SAME classification instead of, say, defaulting to hidden).
    const userBusinessMethods = allDispatched(user.exec)
      .filter((d) => (d.params as { requestId?: string }).requestId?.includes('business'))
      .map((d) => d.method)
    expect(userBusinessMethods).toEqual(expect.arrayContaining([
      'Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished',
    ]))

    // The global mirror sees BOTH requests' full lifecycles, unfiltered.
    const globalIds = new Set(
      allDispatched(global.exec).map((d) => (d.params as { requestId?: string }).requestId),
    )
    const globalHasInternal = [...globalIds].some((id) => typeof id === 'string' && id.includes('internal'))
    const globalHasBusiness = [...globalIds].some((id) => typeof id === 'string' && id.includes('business'))
    expect(globalHasInternal).toBe(true)
    expect(globalHasBusiness).toBe(true)
  })
})

// ── scenario 7: bridge.getSimulatorServerBaseUrl is consulted too ───────────

describe('createNetworkForwarder — user-facing sink also filters the simulator shell\'s own static-asset server, global mirror does not', () => {
  it('hides a request whose origin matches getSimulatorServerBaseUrl from the user-facing sink but still mirrors it globally', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const user = makeDevtoolsWc(true)
    const global = makeDevtoolsWc(true)
    const fwd = createNetworkForwarder({
      getServiceWc: () => svc.wc,
      getSimulatorServerBaseUrl: () => 'http://127.0.0.1:9876/',
    })
    fwd.setDevtoolsHost(user.wc)
    fwd.setGlobalDevtoolsHost(global.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', {
      requestId: 'shell-1', request: { url: 'http://127.0.0.1:9876/simulator-shell.js', method: 'GET' },
    })
    sim.emitMessage('Network.responseReceived', { requestId: 'shell-1', response: { status: 200 } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'shell-1' })
    await flushMicrotasks()

    // Entirely absent from the user-facing sink...
    const userDispatched = allDispatched(user.exec)
    const userRequestIds = userDispatched.map((d) => (d.params as { requestId?: string }).requestId)
    expect(userRequestIds.some((id) => typeof id === 'string' && id.includes('shell-1'))).toBe(false)

    // ...but present in the global mirror.
    const globalDispatched = allDispatched(global.exec)
    const globalMethods = globalDispatched
      .filter((d) => (d.params as { requestId?: string }).requestId?.includes('shell-1'))
      .map((d) => d.method)
    expect(globalMethods).toContain('Network.requestWillBeSent')
    expect(globalMethods).toContain('Network.responseReceived')
    expect(globalMethods).toContain('Network.loadingFinished')
  })

  it('still forwards an ordinary business request into the user-facing sink when getSimulatorServerBaseUrl is configured (regression: must not over-match)', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const user = makeDevtoolsWc(true)
    const fwd = createNetworkForwarder({
      getServiceWc: () => svc.wc,
      getSimulatorServerBaseUrl: () => 'http://127.0.0.1:9876/',
    })
    fwd.setDevtoolsHost(user.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', {
      requestId: 'biz-2', request: { url: 'http://api.example.com/biz', method: 'GET' },
    })
    sim.emitMessage('Network.responseReceived', { requestId: 'biz-2', response: { status: 200 } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'biz-2' })
    await flushMicrotasks()

    const userDispatched = allDispatched(user.exec)
    const methods = userDispatched
      .filter((d) => (d.params as { requestId?: string }).requestId?.includes('biz-2'))
      .map((d) => d.method)
    expect(methods).toContain('Network.requestWillBeSent')
    expect(methods).toContain('Network.responseReceived')
    expect(methods).toContain('Network.loadingFinished')
  })
})
