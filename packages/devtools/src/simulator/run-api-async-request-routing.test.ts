/**
 * Routing tests for `runApiAsync` + `directRequest` (`wx.request` / `qd.request`).
 *
 * Under native-host, the main process strips `success`/`fail`/`complete` from
 * params BEFORE forwarding the API call into `runApiAsync`. So the handler
 * (`directRequest`) receives only the network-level params (url, method, …).
 * `runApiAsync` re-injects sentinel callbacks and resolves the verdict from
 * whichever sentinel fires first.
 *
 * The bug being pinned: `directRequest` does not return its internal fetch
 * promise — it returns `undefined`. `runApiAsync` therefore sees a sync return
 * of `undefined` and (because the params had no success/fail) immediately emits
 * `{ ok: true, result: undefined }` BEFORE the async fetch settles. On actual
 * failure (network error, non-2xx) the real `onFail` sentinel fires later but
 * `settled` is already true, so it is ignored. The premature `ok: true` verdict
 * is the sole emission — wrong on every axis.
 *
 * Contract the tests encode:
 *   1. fetch reject → verdict must be ok:false, NOT ok:true
 *   2. fetch 500    → verdict must be ok:false, NOT ok:true
 *   3. fetch 200    → verdict ok:true AND result contains the parsed body
 *   4. (regression guard) sync handler unrelated to request → still settles ok:true
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runApiAsync, type ApiRunVerdict } from './run-api-async'
import { directRequest } from './direct-request'
import { previewImage } from './simulator-api-media'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseHandler = (this: any, params?: unknown) => unknown

/** Minimal `this` seen by a handler: just the callback factory the seam patches in. */
type SentinelCtx = { createCallbackFunction(fn: unknown): ((...args: unknown[]) => void) | undefined }

function makeMiniApp() {
  return {
    appId: 'test-app',
    apiRegistry: {
      request: directRequest as unknown as LooseHandler,
      getThingSync: (() => ({ ok: 1 })) as unknown as LooseHandler,
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Drain the microtask queue and one macrotask tick so the internal fetch chain
 * (.then(parseResponse).then(onSuccess).catch(onFail).finally(onComplete)) has
 * time to settle before we assert.
 */
async function drainAsync(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0))
  await new Promise<void>((r) => setTimeout(r, 0))
}

describe('runApiAsync + directRequest — wx.request routing (stripped params)', () => {
  it('1. fetch rejection routes to fail (ok:false), NOT a premature ok:true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )

    const miniApp = makeMiniApp()
    const emits: ApiRunVerdict[] = []

    // Stripped params — no success / fail / complete keys, mirroring native-host reality.
    await runApiAsync(miniApp, 'request', { url: 'https://api.example.com/x', method: 'GET' }, (v) => {
      emits.push(v)
    })
    await drainAsync()

    // There must be NO premature ok:true emission.
    expect(emits.some((v) => v.ok === true)).toBe(false)
    // There MUST be at least one ok:false verdict carrying the network error.
    expect(emits.some((v) => v.ok === false)).toBe(true)
  })

  it('2. non-2xx response (HTTP 500) routes to fail (ok:false), NOT ok:true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('Internal Server Error', { status: 500 }))),
    )

    const miniApp = makeMiniApp()
    const emits: ApiRunVerdict[] = []

    await runApiAsync(miniApp, 'request', { url: 'https://api.example.com/x', method: 'GET' }, (v) => {
      emits.push(v)
    })
    await drainAsync()

    expect(emits.some((v) => v.ok === true)).toBe(false)
    expect(emits.some((v) => v.ok === false)).toBe(true)
  })

  it('3. successful 200 JSON response emits ok:true with parsed body in result (not undefined)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ a: 1 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ),
    )

    const miniApp = makeMiniApp()
    const emits: ApiRunVerdict[] = []

    await runApiAsync(miniApp, 'request', { url: 'https://api.example.com/x', method: 'GET' }, (v) => {
      emits.push(v)
    })
    await drainAsync()

    const successVerdict = emits.find((v) => v.ok === true)

    // Must emit an ok:true verdict.
    expect(successVerdict).toBeDefined()
    // result must NOT be undefined — it carries the parsed response.
    expect(successVerdict!.result).toBeDefined()
    // Parsed body arrives as result.data; status is result.statusCode.
    expect(successVerdict!.result).toMatchObject({ data: { a: 1 }, statusCode: 200 })
  })

  it('4. (regression guard) a truly synchronous callback-less handler still settles ok:true from its return value', async () => {
    const miniApp = makeMiniApp()
    const emits: ApiRunVerdict[] = []

    await runApiAsync(miniApp, 'getThingSync', {}, (v) => {
      emits.push(v)
    })

    // Sync handler — no fetch involved, so no drainAsync needed.
    expect(emits).toHaveLength(1)
    expect(emits[0]).toMatchObject({ ok: true, result: { ok: 1 } })
    // One-shot sync APIs must NOT be flagged keep.
    expect(emits[0].keep).not.toBe(true)
  })

  it('5. a fail-wired handler that throws synchronously after wiring still settles ok:false via catch', async () => {
    // Wires the injected FAIL sentinel (so the seam knows the call is async),
    // then throws synchronously. The seam's try/catch must convert the throw
    // into a single ok:false verdict — the wired fail callback never fires, so
    // this pins that the catch path wins and no premature ok:true leaks.
    const miniApp = {
      appId: 'test-app',
      apiRegistry: {
        boom: (function (this: { createCallbackFunction: (id: unknown) => unknown }, params?: unknown) {
          this.createCallbackFunction((params as { fail?: unknown }).fail)
          throw new Error('boom')
        }) as unknown as LooseHandler,
      },
    }
    const emits: ApiRunVerdict[] = []

    await runApiAsync(miniApp, 'boom', {}, (v) => {
      emits.push(v)
    })

    expect(emits).toHaveLength(1)
    expect(emits[0].ok).toBe(false)
    expect(emits.some((v) => v.ok === true)).toBe(false)
    expect(String(emits[0].errMsg)).toContain('boom')
    expect(String(emits[0].errMsg)).toContain('boom:fail')
  })

  it('6. a success-only async handler waits for its real success verdict (showModal class), not a premature undefined', async () => {
    // Regression pin for the showModal premature-settle bug.
    // showModal wires only the success sentinel (it never fails) and resolves
    // when the user taps the modal — i.e. on a future tick, not synchronously.
    // The corrected discriminator is "wired SUCCESS OR FAIL" ⇒ treat as async
    // and wait for the sentinel; the void return must NOT premature-settle.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let deferredSuccess: ((...args: any[]) => void) | undefined

    const miniApp = {
      appId: 'test-app',
      apiRegistry: {
        modalLike: (function (this: SentinelCtx, params?: unknown) {
          // Wire success sentinel and store it; do NOT call it synchronously.
          // Simulates waiting for user interaction (e.g. tapping the modal OK button).
          deferredSuccess = this.createCallbackFunction((params as { success?: unknown }).success)
          // Returns void — the real verdict arrives later.
        }) as unknown as LooseHandler,
      },
    }
    const emits: ApiRunVerdict[] = []

    await runApiAsync(miniApp, 'modalLike', {}, (v) => {
      emits.push(v)
    })

    // Must NOT have premature-settled while waiting for the deferred user action.
    expect(emits).toHaveLength(0)

    // Simulate user tapping OK on the modal.
    deferredSuccess!({ confirm: true, errMsg: 'showModal:ok' })

    expect(emits).toHaveLength(1)
    expect(emits[0]).toMatchObject({ ok: true, result: { confirm: true, errMsg: 'showModal:ok' } })
  })

  it('7. previewImage([]) (complete-only guard path) settles ok:true under stripped params, not a 5s timeout', async () => {
    // Pins that complete-only handlers must settle in production where `complete`
    // is stripped, because the seam always injects the COMPLETE sentinel. With an
    // empty urls list, previewImage([]) fires only onComplete and returns early —
    // no success/fail. The always-injected COMPLETE sentinel routes to
    // finish({ ok: true }), resolving the verdict instead of hanging until the
    // main-side no-handler timeout.
    const miniApp = {
      appId: 'test-app',
      apiRegistry: {
        previewImage: previewImage as unknown as LooseHandler,
      },
    }
    const emits: ApiRunVerdict[] = []

    // Pass ONLY { urls: [] } — no success/fail/complete keys, mirroring
    // production (main strips the callbacks before forwarding to runApiAsync).
    await runApiAsync(miniApp, 'previewImage', { urls: [] }, (v) => emits.push(v))
    await new Promise<void>((r) => setTimeout(r, 0))

    // The COMPLETE sentinel must have settled the call: exactly one ok:true
    // verdict, not a 'no handler (timeout)' fail and not zero emissions/hang.
    expect(emits).toHaveLength(1)
    expect(emits[0].ok).toBe(true)
  })
})
