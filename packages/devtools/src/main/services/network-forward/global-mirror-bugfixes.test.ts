/**
 * Bug-fix-round regression coverage for the Phase 2 "global mirror" sink
 * (`setGlobalDevtoolsHost`), split out from `global-mirror.test.ts` to keep
 * both files under the repo's 500-line-per-file ratchet. Shares the same
 * fixtures — see `global-mirror-test-fixtures.ts`.
 */
import { describe, expect, it } from 'vitest'
import { createNetworkForwarder } from './index.js'
import { allDispatched, flushMicrotasks, makeDevtoolsWc, makeServiceWc, makeSimWc } from './global-mirror-test-fixtures.js'

// ── Bug fix: requestWillBeSentExtraInfo arriving before requestWillBeSent
// must fail CLOSED for an unknown rawId, not fail open ──────────────────────
//
// Real CDP ordering can deliver `Network.requestWillBeSentExtraInfo` before
// `Network.requestWillBeSent` for the same requestId (the code's own
// `resolveUserFacing` doc comment already acknowledges this). ExtraInfo
// carries no url, so it cannot be classified on its own; the CURRENT bug
// fails OPEN for any rawId `resolveUserFacing` has not yet recorded a
// verdict for, which forwards that early ExtraInfo into the user-facing sink
// even when the request turns out to be an internal/framework resource load
// — a one-event leak the very next `requestWillBeSent` cannot retract, since
// the earlier dispatch already reached the front-end. The fix: fail CLOSED
// or an unrecorded rawId's `requestWillBeSentExtraInfo` specifically (drop
// it from the user-facing sink), while every OTHER "rawId never seen"
// scenario keeps failing open (unchanged) since there is no better signal.
describe('createNetworkForwarder — requestWillBeSentExtraInfo arriving before requestWillBeSent must fail closed for an unrecorded rawId', () => {
  it('internal resource: an ExtraInfo arriving before requestWillBeSent is never forwarded to the user-facing sink (still mirrored globally, unfiltered)', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const user = makeDevtoolsWc(true)
    const global = makeDevtoolsWc(true)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(user.wc)
    fwd.setGlobalDevtoolsHost(global.wc)
    fwd.attachSimulator(sim.wc)

    // ExtraInfo arrives BEFORE requestWillBeSent for this rawId — the
    // documented-possible CDP ordering. The eventual classification (once
    // requestWillBeSent lands) is internal (file:// scheme), so the entire
    // request should never reach the user-facing sink — including this
    // early ExtraInfo line, which the current fail-open bug lets through
    // before the classification is even known.
    sim.emitMessage('Network.requestWillBeSentExtraInfo', { requestId: 'x1', headers: {} })
    sim.emitMessage('Network.requestWillBeSent', {
      requestId: 'x1', request: { url: 'file:///dist/app.js', method: 'GET' },
    })
    await flushMicrotasks()

    const userIds = allDispatched(user.exec)
      .map((d) => (d.params as { requestId?: string }).requestId)
    expect(
      userIds.some((id) => typeof id === 'string' && id.includes('x1')),
      'an internal resource\'s requestWillBeSentExtraInfo arriving before requestWillBeSent must never reach the user-facing sink — failing open on the early, not-yet-classified event leaks it before the internal verdict is even recorded',
    ).toBe(false)

    const globalMethodsForX1 = allDispatched(global.exec)
      .filter((d) => (d.params as { requestId?: string }).requestId?.includes('x1'))
      .map((d) => d.method)
    expect(
      globalMethodsForX1,
      'the global mirror is unfiltered and must still see both events regardless of the user-sink classification',
    ).toEqual(expect.arrayContaining(['Network.requestWillBeSentExtraInfo', 'Network.requestWillBeSent']))
  })

  it('business request: the early ExtraInfo (arriving before requestWillBeSent) is fail-closed and dropped, but requestWillBeSent and every later event are forwarded once classified (accepted trade-off: only that one early line is sacrificed)', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const user = makeDevtoolsWc(true)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(user.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSentExtraInfo', { requestId: 'y1', headers: {} })
    sim.emitMessage('Network.requestWillBeSent', {
      requestId: 'y1', request: { url: 'http://api.example.com/x', method: 'GET' },
    })
    sim.emitMessage('Network.responseReceived', { requestId: 'y1', response: { status: 200 } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'y1' })
    await flushMicrotasks()

    const userMethods = allDispatched(user.exec)
      .filter((d) => (d.params as { requestId?: string }).requestId?.includes('y1'))
      .map((d) => d.method)

    expect(
      userMethods,
      'the ExtraInfo that arrived before the rawId had any recorded classification must be fail-closed (dropped) even though the request later classifies as user-facing — this is the accepted trade-off (one line sacrificed, never the whole request)',
    ).not.toContain('Network.requestWillBeSentExtraInfo')

    // The request itself remains fully visible: requestWillBeSent and every
    // later (already-classified) event still reach the user sink normally.
    expect(userMethods).toContain('Network.requestWillBeSent')
    expect(userMethods).toContain('Network.responseReceived')
    expect(userMethods).toContain('Network.loadingFinished')
  })

  it('regression: normal ordering (requestWillBeSent arrives first) is unaffected — its ExtraInfo is still forwarded to the user-facing sink', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const user = makeDevtoolsWc(true)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setDevtoolsHost(user.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', {
      requestId: 'z1', request: { url: 'http://api.example.com/z', method: 'GET' },
    })
    sim.emitMessage('Network.requestWillBeSentExtraInfo', { requestId: 'z1', headers: {} })
    await flushMicrotasks()

    const userMethods = allDispatched(user.exec)
      .filter((d) => (d.params as { requestId?: string }).requestId?.includes('z1'))
      .map((d) => d.method)
    expect(
      userMethods,
      'when requestWillBeSent arrives first, the rawId already has a recorded verdict by the time ExtraInfo arrives — this fix (which only changes the UNRECORDED-rawId case) must not regress this normal ordering',
    ).toContain('Network.requestWillBeSentExtraInfo')
  })
})

// ── Bug B: body prefetch gate must count the global window as a consumer ────
//
// `prefetchBodies` (index.ts) currently gates purely on the USER-facing sink's
// state (`sink === 'idle' && !resolveDevtoolsWc()`). When the right-panel host
// was never set (or is degraded) but a global window IS open, events still
// mirror into the global window (proven above), yet the body is never
// prefetched — so the global window's Response/Preview tab always 404s for
// internal resources it can otherwise see.

describe('createNetworkForwarder — body prefetch counts the global window as a consumer (Bug B)', () => {
  it('prefetches the response body when only the global host is set (the user-facing sink is idle with no host at all)', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const global = makeDevtoolsWc(true)
    sim.sendCommand.mockImplementation((method: string) =>
      method === 'Network.getResponseBody'
        ? Promise.resolve({ body: 'global-only body', base64Encoded: false })
        : Promise.resolve({}))
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    // Deliberately never call fwd.setDevtoolsHost(...): the user-facing sink
    // stays 'idle' with resolveDevtoolsWc() === null throughout this test.
    fwd.setGlobalDevtoolsHost(global.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://api/x', method: 'GET' } })
    sim.emitMessage('Network.responseReceived', { requestId: 'r1', response: { status: 200 } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'r1' })
    await flushMicrotasks()

    // The debugger prefetch must have fired even though no user-facing host
    // was ever configured.
    expect(sim.sendCommand).toHaveBeenCalledWith('Network.getResponseBody', { requestId: 'r1' })

    const dispatched = allDispatched(global.exec)
    const opener = dispatched.find((d) => d.method === 'Network.requestWillBeSent')!
    const virtualId = (opener.params as { requestId: string }).requestId

    await expect(fwd.bodies.getResponseBody(virtualId)).resolves.toEqual({ body: 'global-only body', base64Encoded: false })
  })
})

// ── Bug C: the global dispatch path needs the same settled gate every other
// injection point in this codebase uses ───────────────────────────────────
//
// `dispatchToGlobal` (index.ts) calls `globalDevtoolsWc.executeJavaScript`
// unconditionally, with no `isFrontendSettled` check. `executeJavaScript`
// against a still-loading wc queues one `did-stop-loading` waiter PER CALL
// (see inject-when-ready.ts's header) — exactly the MaxListeners pile-up
// pattern this codebase has already fixed at every other injection site. A
// Network burst that lands while the global host's front-end is still
// booting must NOT queue one waiter per event.

describe('createNetworkForwarder — global dispatch is gated by isFrontendSettled (Bug C)', () => {
  it('does not call executeJavaScript on a global host wc whose front-end has not finished loading yet', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    // isLoading() always true -> isFrontendSettled(wc) must read false.
    const global = makeDevtoolsWc(true, () => true)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setGlobalDevtoolsHost(global.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://api/x', method: 'GET' } })
    sim.emitMessage('Network.responseReceived', { requestId: 'r1', response: { status: 200 } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'r1' })
    await flushMicrotasks()

    expect(global.exec).not.toHaveBeenCalled()
  })
})
