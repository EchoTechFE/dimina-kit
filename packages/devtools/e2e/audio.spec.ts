import { test, expect, useSharedProject } from './fixtures'
import {
  DEMO_APP_DIR,
  evalInSimulator,
  pollUntil,
} from './helpers'

/**
 * End-to-end verification for the audio event bridge.
 *
 * The simulator's audio support has two halves:
 *  - service side  — `service-apis/audio/index.js`'s `InnerAudioContext`,
 *    injected into the dimina service Worker, exposed as
 *    `wx.createInnerAudioContext()`.
 *  - container side — `simulator-api-media.ts`'s `audioCreate`/`audioListen`/…
 *    handlers, which own a real `HTMLAudioElement` and bridge its DOM media
 *    events back to the service via `createCallbackFunction`.
 *
 * Both halves have unit tests; this spec is the missing proof that the WHOLE
 * chain works inside a real running simulator.
 *
 * demo-app/pages/audio-test sets `ctx.src` to a tiny self-contained silent
 * WAV (data: URI — the dimina compiler only copies image assets, so a `.wav`
 * referenced from JS would not reach the bundle), registers `onCanplay` /
 * `onTimeUpdate` / `onEnded` / `onError`, and each callback calls `setData`.
 *
 * Core assertion: after the page loads, the audio page's `data` shows
 * `canplayFired === true`. That flag can only flip if:
 *   container <audio> fires `canplay`
 *     → bound DOM-event handler → `createCallbackFunction` callback
 *       → service-side `InnerAudioContext._dispatch`
 *         → page's `onCanplay` listener → `setData`
 *           → service Worker `ub` message → AppData instrumentation.
 * i.e. the container→service event bridge is end-to-end live.
 *
 * `canplay` (a load-time event) is the primary signal because it needs no
 * user gesture. `play()` may be blocked by the browser autoplay policy
 * (a synthesized click is not a trusted gesture), so this spec does NOT
 * require `play` to succeed — it records whatever it observes.
 */

const AUDIO_PATH = '/pages/audio-test/audio-test'

interface AudioPageData {
  canplayFired?: boolean
  playFired?: boolean
  endedFired?: boolean
  errorFired?: boolean
  timeUpdateCount?: number
  lastEvent?: string
  duration?: number
  errMsg?: string
}

/**
 * Read the audio-test page's live `data` from the simulator runtime.
 *
 * `__simulatorData.getAppdata()` is the flat AppData cache keyed
 * `${bridgeId}/${moduleId}`; `moduleId` starts with `page_`. We pick the entry
 * carrying the audio page's distinctive fields rather than guessing the id.
 * Returns `null` until that page entry exists.
 */
async function readAudioPageData(electronApp: Parameters<typeof evalInSimulator>[0]): Promise<AudioPageData | null> {
  return evalInSimulator<AudioPageData | null>(
    electronApp,
    `(() => {
      const all = (window.__simulatorData && window.__simulatorData.getAppdata && window.__simulatorData.getAppdata()) || {}
      for (const key of Object.keys(all)) {
        if (!key.includes('page_')) continue
        const d = all[key]
        if (d && typeof d === 'object' && 'canplayFired' in d) return d
      }
      return null
    })()`,
  )
}

/** Click an element inside the topmost simulator page iframe by CSS selector. */
async function clickInTopPage(
  electronApp: Parameters<typeof evalInSimulator>[0],
  selector: string,
): Promise<boolean> {
  return evalInSimulator<boolean>(
    electronApp,
    `(() => {
      const iframes = document.querySelectorAll('iframe')
      const iframe = iframes[iframes.length - 1]
      if (!iframe || !iframe.contentDocument) return false
      const el = iframe.contentDocument.querySelector(${JSON.stringify(selector)})
      if (el) { el.click(); return true }
      return false
    })()`,
  )
}

test.describe('Audio event bridge — createInnerAudioContext end-to-end', () => {
  test.describe.configure({ mode: 'serial' })

  useSharedProject(test, DEMO_APP_DIR)

  test('container audio events drive the service-side InnerAudioContext callbacks', async ({ electronApp }) => {
    test.setTimeout(60_000)

    // Navigate from the home menu to the audio page (same pattern as
    // appdata-panel.spec.ts — tap the `[data-path]` menu item dimina binds
    // wx.navigateTo to).
    const navigated = await pollUntil<boolean>(
      () => clickInTopPage(electronApp, `[data-path="${AUDIO_PATH}"]`),
      (ok) => ok === true,
      10000,
      300,
    ).catch(() => false)
    expect(navigated, 'should reach the audio page menu item on the home page').toBe(true)

    // Core assertion: the audio page's data eventually reports canplay.
    // This requires the container <audio> 'canplay' DOM event to traverse the
    // bridge into the service-side onCanplay listener and trigger setData.
    const data = await pollUntil<AudioPageData | null>(
      () => readAudioPageData(electronApp),
      (d) => !!d && d.canplayFired === true,
      20000,
      400,
    )

    expect(data, 'audio page data should be visible in the simulator AppData cache').not.toBeNull()
    expect(data!.canplayFired, 'onCanplay must fire — proves container→service event bridge').toBe(true)
    // `lastEvent` is set by whichever load-time callback ran; canplay is the
    // one we gate on, so it must have been observed at least once.
    expect(['canplay', 'timeUpdate', 'play']).toContain(data!.lastEvent)
    // The bridge also carries the decoded duration of the WAV (~0.3s); a
    // finite, non-negative number confirms the snapshot payload reaches the
    // service side intact rather than just a bare event name.
    expect(typeof data!.duration).toBe('number')
    expect(Number.isFinite(data!.duration)).toBe(true)
    expect(data!.duration!).toBeGreaterThanOrEqual(0)

    // The load path must NOT have surfaced an error event (a broken/invalid
    // src would flip errorFired instead — that would mean the bridge works
    // but the resource doesn't, which we want to catch distinctly).
    expect(data!.errorFired, `audio onError must not fire (errMsg: ${data!.errMsg ?? ''})`).toBeFalsy()
  })

  test('play() best-effort: if autoplay is permitted, playback events also bridge through', async ({ electronApp }) => {
    test.setTimeout(60_000)

    // We are already on the audio page from the previous serial test, but be
    // resilient: re-navigate if the page data is not present (e.g. a reset).
    let data = await readAudioPageData(electronApp)
    if (!data) {
      await pollUntil<boolean>(
        () => clickInTopPage(electronApp, `[data-path="${AUDIO_PATH}"]`),
        (ok) => ok === true,
        10000,
        300,
      ).catch(() => false)
      data = await pollUntil<AudioPageData | null>(
        () => readAudioPageData(electronApp),
        (d) => !!d && d.canplayFired === true,
        20000,
        400,
      )
    }
    expect(data, 'audio page must be loaded').not.toBeNull()

    // Trigger play() via the page's "播放" button (bindtap → ctx.play()).
    const tapped = await clickInTopPage(electronApp, '[data-action="play"]')
    expect(tapped, 'play button should be tappable').toBe(true)

    // Best-effort: a synthesized click is not a trusted user gesture, so the
    // browser autoplay policy may reject `audio.play()`. We do NOT fail the
    // test on that. The WAV is ~0.3s of silence, so when playback IS allowed
    // it runs to `ended` quickly — poll until the clip finishes (or play was
    // never granted), then read the settled state.
    const after = await pollUntil<AudioPageData | null>(
      () => readAudioPageData(electronApp),
      // Settle when the clip has finished playing. If autoplay is blocked,
      // `playFired` stays false forever → the poll times out and we just read
      // the final state below (load-time bridge is already proven by canplay).
      (d) => !!d && d.endedFired === true,
      10000,
      400,
    ).catch(() => readAudioPageData(electronApp))

    expect(after).not.toBeNull()
    if (after!.playFired) {
      // Playback was allowed → the same bridge must have delivered the play
      // event AND the playback-phase events (timeUpdate ticks and/or the
      // final ended) for the 0.3s clip.
      expect(after!.playFired).toBe(true)
      expect(
        (after!.timeUpdateCount ?? 0) > 0 || after!.endedFired === true,
        'once playing, timeUpdate/ended events should also bridge through',
      ).toBe(true)
      console.log('[audio.spec] autoplay permitted — playback events verified end-to-end')
    } else {
      console.log('[audio.spec] play() blocked by autoplay policy — load-time bridge already proven by canplay')
    }
    // Either branch: a real error must not have leaked through.
    expect(after!.errorFired, `audio onError must not fire (errMsg: ${after!.errMsg ?? ''})`).toBeFalsy()
  })
})
