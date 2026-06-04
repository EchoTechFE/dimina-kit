/**
 * Behavior tests for `runApiAsync`'s handling of subscription-class
 * ("persistent") APIs — concretely `audioListen`, the bridge that carries the
 * 9 audio DOM events (canplay / play / timeupdate / ended / …) from the
 * container back to the service-side dispatcher.
 *
 * ── The bug being pinned (TDD red) ──────────────────────────────────────────
 * Under native-host, the dimina submodule strips the service-side `keep: true`
 * flag (and the success/fail callback ids) off the params before they reach the
 * container. So by the time `audioListen` is forwarded into `runApiAsync`, the
 * params are just `{ audioId }` — no `keep`, no `success`, no `fail`.
 *
 * `runApiAsync` currently decides "is this a keep subscription?" purely from
 * `params.keep === true`. With `keep` stripped that is false, so:
 *   1. The handler returns synchronously (audioListen binds DOM listeners and
 *      returns undefined). Because the original params had no success/fail,
 *      `runApiAsync` treats it as a callback-less sync API and IMMEDIATELY
 *      emits one empty `{ ok: true }` verdict — a premature one-shot settle.
 *   2. Worse, every later DOM event (the real canplay/play/timeupdate/ended)
 *      reaches the captured callback AFTER `settled` is true, and since the
 *      call wasn't recognised as keep, those fires are DROPPED. The second and
 *      subsequent audio events never leave the container.
 *
 * The contract these tests pin (implemented elsewhere — `runApiAsync` must
 * recognise persistent APIs BY NAME via `isPersistentSimulatorApi`):
 *   - A persistent API with NO success/fail in its (stripped) params must NOT
 *     emit a synchronous empty settle. The first real verdict comes from a DOM
 *     event, not from the sync return.
 *   - EVERY DOM event fire must emit a `{ keep: true, ok: true }` verdict — the
 *     SECOND fire is not swallowed by a first empty settle.
 *
 * Seam: we drive the REAL `audioListen` handler (registered as
 * `apiRegistry.audioListen`) and dispatch real DOM media events on the
 * container's HTMLAudioElement, asserting on what `runApiAsync` `emit`s. The
 * test never names the keep-detection mechanism; it asserts the observable
 * outcome (events reach the service via repeated `{ keep: true }` emits).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runApiAsync, type ApiRunVerdict } from './run-api-async'
import { audioCreate, audioListen } from './simulator-api-media'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseHandler = (this: any, params?: unknown) => unknown

/** Minimal MiniAppLike whose apiRegistry holds the real media handlers. */
function makeMiniApp(): { appId: string; apiRegistry: Record<string, LooseHandler> } {
  return {
    appId: 'test-app',
    apiRegistry: {
      audioCreate: audioCreate as unknown as LooseHandler,
      audioListen: audioListen as unknown as LooseHandler,
    },
  }
}

// Capture every HTMLAudioElement the container creates via `new Audio()` so a
// test can dispatch DOM media events onto the exact element audioListen bound.
let createdAudioEls: HTMLAudioElement[] = []
const RealAudio = globalThis.Audio

beforeEach(() => {
  createdAudioEls = []
  vi.stubGlobal('Audio', class extends RealAudio {
    constructor(...args: unknown[]) {
      // @ts-expect-error -- forward to the real Audio constructor
      super(...args)
      createdAudioEls.push(this as unknown as HTMLAudioElement)
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Register `audioListen` for `audioId` through `runApiAsync` with the params as
 * they ACTUALLY arrive under native-host: keep + success/fail already stripped
 * by the submodule, leaving only `{ audioId }`. Returns the captured element +
 * the list of verdicts emitted (in order).
 */
async function listenViaRunApiAsync(audioId: number): Promise<{
  audioEl: HTMLAudioElement
  emits: ApiRunVerdict[]
}> {
  const miniApp = makeMiniApp()
  // Create the underlying audio instance first (service does audioCreate then
  // audioListen). audioCreate is fire-and-forget; run it directly.
  miniApp.apiRegistry.audioCreate.call(
    { appId: miniApp.appId, createCallbackFunction: () => undefined },
    { audioId },
  )

  const emits: ApiRunVerdict[] = []
  // NOTE: stripped params — no `keep`, no `success`, no `fail`. This is the
  // native-host reality the bug arises from.
  await runApiAsync(miniApp, 'audioListen', { audioId }, (v) => { emits.push(v) })

  const audioEl = createdAudioEls.at(-1)!
  expect(audioEl).toBeInstanceOf(HTMLAudioElement)
  return { audioEl, emits }
}

describe('runApiAsync — persistent (keep) subscription APIs', () => {
  it('does NOT emit a premature empty settle when audioListen has no success/fail params', async () => {
    const { emits } = await listenViaRunApiAsync(201)

    // The subscription is now armed but no audio event has fired yet. A correct
    // persistent path emits nothing until a DOM event arrives. The buggy path
    // emits one empty `{ ok: true }` here (the sync callback-less settle).
    expect(emits).toEqual([])
  })

  it('emits a keep:true verdict on EACH audio DOM event, including the second (not dropped)', async () => {
    const { audioEl, emits } = await listenViaRunApiAsync(202)

    audioEl.dispatchEvent(new Event('canplay'))
    audioEl.dispatchEvent(new Event('play'))
    audioEl.dispatchEvent(new Event('timeupdate'))

    // Three DOM events ⇒ three verdicts back toward main. The buggy path emits
    // at most one (the premature empty settle) and drops every real fire.
    expect(emits.length).toBe(3)

    // Every emitted verdict for a subscription must be marked keep:true so main
    // re-fires the service callback WITHOUT tearing the subscription down.
    for (const v of emits) {
      expect(v.ok).toBe(true)
      expect(v.keep).toBe(true)
    }
  })

  it('the second fire carries the audio event payload (it actually reached emit)', async () => {
    const { audioEl, emits } = await listenViaRunApiAsync(203)

    audioEl.dispatchEvent(new Event('canplay'))
    audioEl.dispatchEvent(new Event('ended'))

    expect(emits.length).toBe(2)
    // The audio event-bridge payload (`{ event, currentTime, ... }`) rides on
    // the verdict.result. The 2nd fire must be the `ended` event — proof it was
    // not swallowed by a first empty settle.
    const second = emits[1].result as Record<string, unknown> | undefined
    expect(second).toMatchObject({ event: 'ended' })
  })
})

describe('runApiAsync — ordinary one-shot APIs are unaffected', () => {
  it('still emits exactly one verdict for a callback-less sync API', async () => {
    const miniApp = {
      appId: 'test-app',
      apiRegistry: {
        getSystemInfoSync: (() => ({ platform: 'devtools' })) as unknown as LooseHandler,
      },
    }
    const emits: ApiRunVerdict[] = []
    await runApiAsync(miniApp, 'getSystemInfoSync', {}, (v) => { emits.push(v) })

    expect(emits.length).toBe(1)
    expect(emits[0].ok).toBe(true)
    // A one-shot must NOT be marked keep — only subscription APIs are.
    expect(emits[0].keep).not.toBe(true)
    expect(emits[0].result).toMatchObject({ platform: 'devtools' })
  })
})
