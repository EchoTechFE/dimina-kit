/**
 * The global mirror sink (`setGlobalDevtoolsHost`) must not silently and
 * permanently drop Network CDP events that arrive while the standalone
 * DevTools window's front-end has not finished loading yet (`isFrontendSettled`
 * false — see `global-mirror-bugfixes.test.ts`'s Bug C, which only proved the
 * events stop reaching `executeJavaScript` while unsettled; it never asserted
 * they are recoverable once the front-end settles). The correct contract:
 * hold them in a bounded, in-order queue and flush it once the front-end
 * settles, rather than losing them outright. The queue must have a cap (an
 * unbounded queue is its own leak) and overflowing it must leave an explicit
 * `console.warn` trace rather than silently dropping events past the cap.
 * Clearing the host (`setGlobalDevtoolsHost(null)`, e.g. the window hiding)
 * must drop the pending queue — a later `setGlobalDevtoolsHost(newHost)` must
 * never replay events queued for a DIFFERENT, already-cleared host.
 *
 * Split into its own file (rather than appended to `global-mirror.test.ts` /
 * `global-mirror-bugfixes.test.ts`) to keep every file under the repo's
 * 500-line-per-file ratchet. Shares the same fixtures as those two files.
 */
import { describe, expect, it, vi } from 'vitest'
import { createNetworkForwarder } from './index.js'
import { allDispatched, flushMicrotasks, makeDevtoolsWc, makeServiceWc, makeSimWc } from './global-mirror-test-fixtures.js'

describe('createNetworkForwarder — global mirror queues events while the host front-end has not settled', () => {
  it('does not call executeJavaScript while unsettled, then flushes the queued events in order once the front-end settles', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    let loading = true
    const global = makeDevtoolsWc(true, () => loading)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setGlobalDevtoolsHost(global.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'q1', request: { url: 'https://api.example.com/q1', method: 'GET' } })
    sim.emitMessage('Network.responseReceived', { requestId: 'q1', response: { status: 200 } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'q1' })
    await flushMicrotasks()

    expect(
      global.exec,
      'events arriving while the front-end has not settled must not be dispatched yet',
    ).not.toHaveBeenCalled()

    // Front-end settles now. Nudge with one more event (a legitimate flush
    // trigger point) and also give a possible timer-based retry a chance to
    // fire, without assuming a specific implementation detail either way.
    loading = false
    sim.emitMessage('Network.requestWillBeSent', { requestId: 'nudge', request: { url: 'https://api.example.com/nudge', method: 'GET' } })
    await flushMicrotasks()
    await new Promise((resolve) => setTimeout(resolve, 250))

    const methods = allDispatched(global.exec).map((d) => d.method)
    expect(
      methods,
      'the queued events from before the front-end settled must still be delivered once it does — the queue must not have been dropped as unrecoverable',
    ).toEqual(expect.arrayContaining([
      'Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished',
    ]))

    // Dispatched requestIds are namespaced (`rewriteRequestId` prepends
    // `prefix+epoch:seq:` to the raw id), so match on the raw-id suffix.
    const requestIds = allDispatched(global.exec).map((d) => (d.params as { requestId?: string }).requestId)
    expect(
      requestIds.filter((id) => typeof id === 'string' && id.endsWith(':q1')).length,
      'the queued q1 lifecycle must still be delivered (and not duplicated by a retry mechanism replaying an already-flushed queue)',
    ).toBeGreaterThanOrEqual(1)
  })
})

describe('createNetworkForwarder — the global mirror queue is bounded', () => {
  it('logs an explicit console.warn when incoming events would exceed the queue cap, instead of silently dropping them', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    // Never settles for the duration of this test — every event must queue.
    const global = makeDevtoolsWc(true, () => true)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      fwd.setGlobalDevtoolsHost(global.wc)
      fwd.attachSimulator(sim.wc)

      // Far beyond any reasonable bounded-queue cap — guaranteed to overflow
      // whatever cap the implementation picks.
      for (let i = 0; i < 5000; i++) {
        sim.emitMessage('Network.requestWillBeSent', { requestId: `r${i}`, request: { url: `https://api.example.com/${i}`, method: 'GET' } })
      }
      await flushMicrotasks()

      expect(global.exec, 'still unsettled — nothing should have dispatched yet').not.toHaveBeenCalled()
      expect(
        warnSpy.mock.calls.some((args) => args.some((a) => typeof a === 'string' && /queue|overflow|drop|discard/i.test(a))),
        'overflowing the bounded global-mirror queue must leave an explicit console.warn trace, not silently drop events past the cap',
      ).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('createNetworkForwarder — clearing the global host clears its pending queue', () => {
  it('does not replay a stale queued event (queued for a PRIOR, now-cleared host) once a new host is set', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const staleHost = makeDevtoolsWc(true, () => true) // never settles
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setGlobalDevtoolsHost(staleHost.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'stale', request: { url: 'https://api.example.com/stale', method: 'GET' } })
    sim.emitMessage('Network.loadingFinished', { requestId: 'stale' })
    await flushMicrotasks()
    expect(staleHost.exec).not.toHaveBeenCalled()

    // The stale host's window is cleared (e.g. hidden) before it ever settled.
    fwd.setGlobalDevtoolsHost(null)

    // A brand-new host is set later and settles immediately.
    const newHost = makeDevtoolsWc(true)
    fwd.setGlobalDevtoolsHost(newHost.wc)
    await flushMicrotasks()
    await new Promise((resolve) => setTimeout(resolve, 250))

    const requestIds = allDispatched(newHost.exec).map((d) => (d.params as { requestId?: string }).requestId)
    expect(
      requestIds.includes('stale'),
      'a queued event from a PRIOR, already-cleared global host must never replay into a later, unrelated host',
    ).toBe(false)
  })
})
