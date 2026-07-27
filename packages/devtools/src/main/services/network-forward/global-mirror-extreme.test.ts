/**
 * Adversarial-input / extreme-scale tests for the global-mirror sink of
 * `createNetworkForwarder` (`setGlobalDevtoolsHost` / `globalPendingQueue` /
 * `scheduleGlobalFlush` / `flushGlobalPending` / `dispatchToGlobal`), plus a
 * couple of pure unit tests on `packDispatchBatch` (the native sink's greedy
 * batch-packer) that the existing suite exercises only indirectly.
 *
 * Independent adversarial-test-author pass: written against the CURRENT
 * implementation without modifying it. Each `it()` states up front which bug
 * it is trying to catch; a case that cannot catch anything concrete was left
 * out rather than padded in.
 */
import { describe, expect, it, vi } from 'vitest'
import { createNetworkForwarder } from './index.js'
import { packDispatchBatch } from './dispatch-batch.js'
import { allDispatched, flushMicrotasks, makeDevtoolsWc, makeServiceWc, makeSimWc } from './global-mirror-test-fixtures.js'

describe('packDispatchBatch — pure edge cases (no existing direct unit test for this exported function)', () => {
  it('a message strictly between maxBatchChars and maxSingleChars is still packed as its own one-message batch (not chunked, not dropped)', () => {
    const msg = 'x'.repeat(700_000) // between 512K (maxBatchChars) and 1M (maxSingleChars)
    const { batch, chunked, remaining } = packDispatchBatch([msg], 1_000_000, 512 * 1024)

    expect(chunked, 'must not be routed to the chunked transport — it is under maxSingleChars').toEqual([])
    expect(batch).toEqual([msg])
    expect(remaining).toEqual([])
  })

  it('an oversized message reached WHILE batch is empty is pulled into chunked and packing continues past it', () => {
    const oversized = 'x'.repeat(2_000_000)
    const normal = 'y'.repeat(100)
    const { batch, chunked, remaining } = packDispatchBatch([oversized, normal], 1_000_000, 512 * 1024)

    expect(chunked).toEqual([oversized])
    expect(batch).toEqual([normal])
    expect(remaining).toEqual([])
  })

  it('an oversized message reached AFTER batch already has items stops packing there (order-preserving), leaving it for the next pass', () => {
    const normal = 'y'.repeat(100)
    const oversized = 'x'.repeat(2_000_000)
    const { batch, chunked, remaining } = packDispatchBatch([normal, oversized], 1_000_000, 512 * 1024)

    expect(batch).toEqual([normal])
    expect(chunked, 'the oversized message must not be chunked in the SAME pass once batch is non-empty — order must be preserved').toEqual([])
    expect(remaining).toEqual([oversized])
  })

  it('never returns an empty pass (no possible infinite loop) for a queue of only-oversized messages: each is drained into chunked one at a time', () => {
    const queue = [
      'a'.repeat(2_000_000),
      'b'.repeat(2_000_000),
      'c'.repeat(2_000_000),
    ]
    const result = packDispatchBatch(queue, 1_000_000, 512 * 1024)
    // All three get pulled into chunked in one pass (batch stays empty the
    // whole time, so the "stop once batch non-empty" rule never engages).
    expect(result.chunked.length).toBe(3)
    expect(result.batch).toEqual([])
    expect(result.remaining).toEqual([])
  })
})

describe('createNetworkForwarder — global mirror: single oversized event, native sink comparison', () => {
  /**
   * The NATIVE (user-facing) sink's `flushDispatch` routes anything over
   * `MAX_SINGLE_DISPATCH_CHARS` (1,000,000 chars) through `dispatchChunked`
   * (see index.test.ts's "chunked dispatch (MAJOR 4)"). The GLOBAL mirror's
   * `dispatchToGlobal` (settled, live path) and `flushGlobalPending` (queued
   * path) build `buildDispatchScript([json])` unconditionally — neither ever
   * checks message size against any threshold or routes through
   * `dispatchChunked`. This test proves that gap: the SAME 1.2MB message that
   * forces the native sink onto the chunked transport is sent to the global
   * mirror as one giant, unchunked `executeJavaScript` call instead.
   *
   * This is a genuine implementation gap, not a test-authoring mistake: a
   * script this large risks exceeding Electron/V8's own script-size or IPC
   * limits (exactly the risk `MAX_SINGLE_DISPATCH_CHARS`/`buildChunkedDispatchScript`
   * exist to avoid on the native path), and unlike the native path's failure
   * handling (`flushDispatch`'s `.catch()` re-queues the batch and retries),
   * a failed `dispatchToGlobal`/`flushGlobalPending` call is fire-and-forget
   * (`.catch(() => { /* best-effort *\/ })`) with NO re-queue — so if the
   * oversized script does fail in a real front-end, that event is silently
   * gone forever, contradicting this same file's own doc comment on
   * `dispatchToGlobal` ("the events here are NOT re-derivable later... they
   * queue for a post-settle flush instead of dropping").
   */
  it('EXPECTED (currently failing): the global mirror should also use the chunked transport for a message over MAX_SINGLE_DISPATCH_CHARS, matching the native sink', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const global = makeDevtoolsWc(true) // settled immediately (default isLoading() => false)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setGlobalDevtoolsHost(global.wc)
    fwd.attachSimulator(sim.wc)

    const hugeUrl = 'https://big/' + 'a'.repeat(1_200_000)
    sim.emitMessage('Network.requestWillBeSent', { requestId: 'huge', request: { url: hugeUrl, method: 'GET' } })
    await flushMicrotasks()

    const calls = global.exec.mock.calls.map((c) => String(c[0]))
    const usesChunkedTransport = calls.some((s) => s.includes('dispatchMessageChunk'))
    expect(
      usesChunkedTransport,
      'the global mirror sent this 1.2MB message via the plain single-batch dispatchMessage script — it never fell back to the chunked transport the native sink uses above the exact same 1MB threshold',
    ).toBe(true)
  })

  it('a failed executeJavaScript for a queued batch is attempted exactly once — no re-queue-and-retry, unlike the native sink which re-queues a failed batch and tries again', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    let loading = true
    const global = makeDevtoolsWc(true, () => loading)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setGlobalDevtoolsHost(global.wc)
    fwd.attachSimulator(sim.wc)

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'retryme', request: { url: 'https://api/retryme', method: 'GET' } })
    await flushMicrotasks()
    expect(global.exec, 'queued while unsettled').not.toHaveBeenCalled()

    // Front-end settles, but EVERY executeJavaScript call rejects from here
    // on (simulating a front-end that keeps refusing the script) — if there
    // were a re-queue-and-retry loop like the native sink's, this single
    // event would be attempted again and again; a bare fire-and-forget drop
    // means exactly one attempt, ever.
    loading = false
    global.exec.mockRejectedValue(new Error('front-end refused the script'))
    await new Promise((resolve) => setTimeout(resolve, 250))

    const attemptsContainingRetryme = global.exec.mock.calls.filter((c) => String(c[0]).includes('retryme')).length
    expect(
      attemptsContainingRetryme,
      'a batch containing "retryme" must have been attempted exactly once — a retry loop would have attempted it again on the next poll/flush cycle',
    ).toBe(1)
  })
})

describe('createNetworkForwarder — global mirror survives a poisoned (circular) CDP params object', () => {
  it('a params object with a circular reference is silently dropped by JSON.stringify\'s guard, and does not block subsequent events', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const global = makeDevtoolsWc(true)
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.setGlobalDevtoolsHost(global.wc)
    fwd.attachSimulator(sim.wc)

    const poisonedParams: Record<string, unknown> = { requestId: 'poison', request: { url: 'https://x/poison', method: 'GET' } }
    // rewriteRequestId spreads params into a new object (`{...p, requestId}`)
    // — a shallow spread does not break on a circular reference living
    // *inside* a nested value, so the poison must be on a field that survives
    // the spread into JSON.stringify's input.
    poisonedParams.self = poisonedParams

    expect(() => sim.emitMessage('Network.requestWillBeSent', poisonedParams)).not.toThrow()
    await flushMicrotasks()
    expect(global.exec, 'the poisoned message must not have reached executeJavaScript').not.toHaveBeenCalled()

    sim.emitMessage('Network.requestWillBeSent', { requestId: 'clean', request: { url: 'https://x/clean', method: 'GET' } })
    await flushMicrotasks()

    const requestIds = allDispatched(global.exec).map((d) => (d.params as { requestId?: string }).requestId)
    expect(
      requestIds.some((id) => typeof id === 'string' && id.endsWith(':clean')),
      'a normal event AFTER the poisoned one must still reach the global mirror',
    ).toBe(true)
  })
})

describe('createNetworkForwarder — global mirror under a 5000-event flood interleaved with 10 host churns', () => {
  it('never replays a pre-churn queued event into a later host, crashes, or produces an unbounded number of overflow warnings', async () => {
    const sim = makeSimWc()
    const svc = makeServiceWc()
    const fwd = createNetworkForwarder({ getServiceWc: () => svc.wc })
    fwd.attachSimulator(sim.wc)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const CYCLES = 10
      const EVENTS_PER_CYCLE = 500 // 10 * 500 = 5000 events total
      for (let cycle = 0; cycle < CYCLES; cycle++) {
        // A host that never settles for this cycle — every event it receives
        // queues rather than dispatches.
        const churnHost = makeDevtoolsWc(true, () => true)
        expect(() => {
          fwd.setGlobalDevtoolsHost(null)
          fwd.setGlobalDevtoolsHost(churnHost.wc)
          for (let i = 0; i < EVENTS_PER_CYCLE; i++) {
            sim.emitMessage('Network.requestWillBeSent', {
              requestId: `c${cycle}-${i}`,
              request: { url: `https://api/${cycle}/${i}`, method: 'GET' },
            })
          }
        }, `cycle ${cycle} must not throw`).not.toThrow()
      }
      await flushMicrotasks()

      // Final, settled host attached after the last churn.
      const finalHost = makeDevtoolsWc(true)
      fwd.setGlobalDevtoolsHost(finalHost.wc)
      sim.emitMessage('Network.requestWillBeSent', { requestId: 'marker', request: { url: 'https://api/marker', method: 'GET' } })
      await flushMicrotasks()
      await new Promise((resolve) => setTimeout(resolve, 250))

      const requestIds = allDispatched(finalHost.exec).map((d) => (d.params as { requestId?: string }).requestId)
      expect(
        requestIds.some((id) => typeof id === 'string' && id.endsWith(':marker')),
        'the final host must receive the post-churn marker event',
      ).toBe(true)
      expect(
        requestIds.some((id) => typeof id === 'string' && /^dimina:sim:.*:c\d+-\d+$/.test(id)),
        'none of the 5000 flooded events queued for an earlier, already-cleared churn host may ever replay into the final host',
      ).toBe(false)

      expect(
        warnSpy.mock.calls.length,
        'an overflow/warn call must scale with the number of DISTINCT overflow episodes (bounded by CYCLES), never with the raw 5000-event flood volume',
      ).toBeLessThanOrEqual(CYCLES + 1)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
