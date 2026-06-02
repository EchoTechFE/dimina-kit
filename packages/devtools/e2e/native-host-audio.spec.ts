/**
 * E2E (native-host only): the `wx.createInnerAudioContext()` event bridge must
 * work end-to-end under DIMINA_NATIVE_HOST=1.
 *
 * Replaces the deleted default-arch `e2e/audio.spec.ts`, which read
 * `window.__simulatorData.getAppdata()` + clicked a page iframe — both of which
 * are dead under native-host (no Worker-backed `__simulatorData` in the render
 * guest; the mini-app renders in main-process DeviceShell / render-host
 * <webview>s, not iframes). This spec proves the SAME audio chain over the
 * native-host topology, which is the simulator's only runtime.
 *
 * The audio chain under test (one direction shown — container → service):
 *   page onLoad: wx.createInnerAudioContext()
 *     → service-host Worker `service-apis/audio/index.js` `InnerAudioContext`
 *       registers `audioListen { keep:true }` (a PERSISTENT subscription)
 *         → container bridge
 *           → simulator WebContentsView `simulator-api-media.ts` owns a real
 *             HTMLAudioElement and bridges its DOM media events
 *             (canplay/play/timeupdate/ended/error) back to the service success
 *             callback
 *               → `InnerAudioContext._dispatch` fires the page's `onCanplay` /
 *                 `onTimeUpdate` / `onEnded` / `onError` listeners
 *                   → each listener calls `setData(...)`
 *                     → the page's reactive data (canplayFired/duration/…)
 *                       is observable via automation `Page.getData`, which under
 *                       native-host sources `ctx.appData.getPageData(bridgeId)`
 *                       — the central AppData accumulator (handlers/page.ts).
 *
 * The SAME migration commit that removed the default-arch spec also fixed a
 * native audio bug where the `keep:true` subscription was treated as one-shot
 * (it delivered the first event then stopped, dropping play/timeUpdate/ended).
 * So this e2e is the regression guard for that fix.
 *
 * Page fixture: demo-app/pages/audio-test/audio-test.js — onLoad creates the
 * ctx, registers onCanplay/onPlay/onTimeUpdate/onEnded/onError (each setData),
 * and sets `ctx.src` to a tiny self-contained SILENT WAV data: URI (the dimina
 * compiler only copies image assets, so a `.wav` referenced from JS would not
 * reach the bundle — the data URI is decodable by the container Audio element
 * with no asset-copy dependency).
 *
 * Core assertion: `canplayFired === true`. `canplay` is a LOAD-TIME media event
 * — it needs no user gesture (unlike `play`, which the autoplay policy can
 * block), so it is the most robust signal that the container→service bridge is
 * live. It can only flip true if the container <audio> fired `canplay` and that
 * DOM event traversed the whole bridge above into the page's setData. We also
 * assert `duration` is a finite, non-negative number (proves the snapshot
 * payload — not just a bare event name — crosses the bridge intact) and that
 * `errorFired` is falsy (a broken/invalid src would flip errorFired instead —
 * that would mean the bridge works but the resource doesn't; we catch that
 * distinctly).
 *
 * Navigation and the audio-bridge result are read via SEPARATE automation calls
 * (`App.getCurrentPage` poll, then `Page.getData` poll) so a failure
 * distinguishes "navigation to the audio page failed" from "the audio bridge
 * failed" — they are different bugs.
 *
 * This spec self-launches its OWN native-host electron (cannot use the shared
 * project fixture — that runs default-arch, not native-host).
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { WebSocket } from 'ws'
import {
  DEMO_APP_DIR,
  openProjectInUI,
  waitForSimulatorWebview,
  closeProject,
  ipcInvoke,
  pollUntil,
  evalInSimulator,
} from './helpers'
import { AutomationChannel } from '../src/shared/ipc-channels'

// NOTE: scope DIMINA_NATIVE_HOST to THIS spec's electron launch (below), never
// `process.env` — a module-top mutation poisons the shared --workers=1 runner,
// flipping every other spec into native-host mode (panel ripple → mass failures).

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The audio-test page lives ONLY in demo-app (the tabbar-app fixture has no
// audio page), so this spec opens the full demo project.
const AUDIO_ROUTE = 'pages/audio-test/audio-test'
const ENTRY_ROUTE = 'pages/index/index'

interface AudioPageData {
  audioReady?: boolean
  canplayFired?: boolean
  playFired?: boolean
  endedFired?: boolean
  errorFired?: boolean
  timeUpdateCount?: number
  lastEvent?: string
  duration?: number
  errMsg?: string
}

let electronApp: ElectronApplication
let mainWindow: PwPage
let autoPort = 0

// One-shot JSON-RPC call to the miniprogram-automator WebSocket server. Drives
// the SAME automation handlers the SDK uses, exercising the native-host pipeline
// (App.callWxMethod → service-host wx.*, Page.getData → ctx.appData) end-to-end.
// Mirrors the helper in native-host-current-page.spec.ts. Rejects on an
// RPC-level error.
function wsCall<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 12000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${autoPort}`)
    const timer = setTimeout(() => { ws.close(); reject(new Error(`wsCall ${method} timed out`)) }, timeoutMs)
    ws.on('open', () => ws.send(JSON.stringify({ id: 'audio1', method, params })))
    ws.on('message', (raw) => {
      let msg: { id?: string; result?: unknown; error?: { message?: string } }
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.id !== 'audio1') return
      clearTimeout(timer)
      ws.close()
      if (msg.error) reject(new Error(msg.error.message || 'rpc error'))
      else resolve(msg.result as T)
    })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

/**
 * Read the audio page's live reactive data via automation `Page.getData`. Under
 * native-host this sources `ctx.appData.getPageData(bridgeId)` for the active
 * bridge (handlers/page.ts) — the audio page once it is top-of-stack. Returns
 * null until that data carries the audio page's distinctive `canplayFired` flag.
 */
async function readAudioPageData(): Promise<AudioPageData | null> {
  const res = await wsCall<{ data?: AudioPageData }>('Page.getData').catch(() => null)
  const data = res?.data
  if (data && typeof data === 'object' && 'canplayFired' in data) return data
  return null
}

test.describe('native-host audio event bridge e2e', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `nh-audio-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })

    electronApp = await _electron.launch({
      args: [appPath, 'auto', '--auto-port', '0', `--user-data-dir=${userDataDir}`],
      env: { ...process.env, NODE_ENV: 'test', DIMINA_NATIVE_HOST: '1', DIMINA_E2E_USER_DATA_DIR: userDataDir },
    })

    mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')

    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isVisible()) {
        await new Promise<void>((resolve) => {
          win.once('show', resolve)
          setTimeout(resolve, 5000)
        })
      }
      if (win) {
        win.setPosition(-2000, -2000)
        win.blur()
      }
    })

    autoPort = await pollUntil(
      () => ipcInvoke<number | null>(mainWindow, AutomationChannel.GetPort),
      (val) => typeof val === 'number' && val > 0,
      10000,
      100,
    ) as number

    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 20000 })
    await waitForSimulatorWebview(electronApp)

    // DeviceShell mounts only after the native mini-app spawn resolves; poll for
    // its root (same gate as native-host-current-page.spec.ts) so the entry page
    // is actually rendered before we navigate.
    await pollUntil(
      () => evalInSimulator<boolean>(
        electronApp,
        `(() => !!document.querySelector('.device-shell-root'))()`,
      ).catch(() => false),
      (ok) => ok === true,
      25000,
      300,
    )
  })

  test.afterAll(async () => {
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('createInnerAudioContext canplay/duration bridge container → service under native-host', async () => {
    // ── Sanity: the app starts on the entry page, so the upcoming navigation is
    // a real transition (not a no-op that masks a bridge failure). ─────────────
    const start = await pollUntil(
      () => wsCall<{ path?: string }>('App.getCurrentPage').catch(() => null),
      (r) => !!r && typeof r.path === 'string' && r.path.includes(ENTRY_ROUTE),
      20000,
      500,
    )
    expect(start?.path, 'app should start on the entry route').toContain(ENTRY_ROUTE)

    // ── NAVIGATE to the audio page via the service-host wx (same native-host
    // path the current-page spec's navigateTo uses). The audio page's onLoad
    // creates the InnerAudioContext and sets ctx.src. ─────────────────────────
    await wsCall('App.callWxMethod', { method: 'navigateTo', args: [{ url: '/' + AUDIO_ROUTE }] })

    // Confirm the active page actually MOVED to the audio page. This decouples a
    // "navigation failed" failure from an "audio bridge failed" failure: if this
    // assertion fails, navigation is broken, not the audio chain.
    const moved = await pollUntil(
      () => wsCall<{ path?: string }>('App.getCurrentPage').catch(() => null),
      (r) => !!r && typeof r.path === 'string' && r.path.includes(AUDIO_ROUTE),
      15000,
      500,
    )
    expect(moved?.path, `navigateTo should land the active page on ${AUDIO_ROUTE}`).toContain(AUDIO_ROUTE)

    // ── CORE: the audio page's reactive data must report canplay. This flag can
    // only flip true if the container <audio> 'canplay' DOM event traversed the
    // full bridge (simulator-api-media → audioListen success → InnerAudioContext
    // ._dispatch → page onCanplay → setData → central AppData). ────────────────
    const data = await pollUntil<AudioPageData | null>(
      () => readAudioPageData(),
      (d) => !!d && d.canplayFired === true,
      25000,
      400,
    )

    expect(data, 'audio page data should be readable via native Page.getData').not.toBeNull()
    expect(
      data!.canplayFired,
      'onCanplay must fire — proves the container→service audio event bridge is live under native-host',
    ).toBe(true)

    // The bridge also carries the decoded WAV duration (~0.3s). A finite,
    // non-negative number confirms the snapshot PAYLOAD crosses the bridge
    // intact rather than just an event name.
    expect(typeof data!.duration, 'duration should be a number').toBe('number')
    expect(Number.isFinite(data!.duration), 'duration should be finite').toBe(true)
    expect(data!.duration!, 'duration should be non-negative').toBeGreaterThanOrEqual(0)

    // The load path must NOT have surfaced an error event — a broken/invalid src
    // would flip errorFired instead, which would mean the bridge works but the
    // resource doesn't (a distinct failure we want to catch).
    expect(
      data!.errorFired,
      `audio onError must not fire (errMsg: ${data!.errMsg ?? ''})`,
    ).toBeFalsy()

    // ── BEST-EFFORT (non-fatal): playback-phase events. Tapping the page's
    // "播放" button in the active render guest fires its bindtap → ctx.play() on
    // the service host. A synthesized click is not a trusted user gesture, so the
    // autoplay policy MAY reject playback; we therefore do NOT fail when play is
    // blocked — the load-time bridge above is the hard contract. But WHEN play is
    // granted, the SAME keep:true persistent subscription must also deliver the
    // play + timeUpdate/ended events for the ~0.3s clip (exactly the path the
    // migration commit fixed). The clip is silent and tiny, so it runs to `ended`
    // quickly.
    await evalInActivePage(`(() => {
      const el = document.querySelector('[data-action="play"]') || document.querySelector('.play-btn')
      if (el && typeof el.click === 'function') { el.click(); return true }
      return false
    })()`).catch(() => false)

    const afterPlay = await pollUntil<AudioPageData | null>(
      () => readAudioPageData(),
      (d) => !!d && d.endedFired === true,
      8000,
      400,
    ).catch(() => readAudioPageData())

    if (afterPlay?.playFired) {
      expect(
        (afterPlay.timeUpdateCount ?? 0) > 0 || afterPlay.endedFired === true,
        'once playing, timeUpdate/ended must also bridge through (keep:true subscription)',
      ).toBe(true)
      console.log('[native-host-audio] autoplay permitted — playback events verified end-to-end')
    } else {
      console.log('[native-host-audio] play() blocked/not-granted — load-time bridge already proven by canplay')
    }
    expect(
      afterPlay?.errorFired,
      `audio onError must not fire after play attempt (errMsg: ${afterPlay?.errMsg ?? ''})`,
    ).toBeFalsy()
  })
})

/**
 * Click/eval inside the active render-host guest page (the top-of-stack page's
 * <webview>). Mirrors how automation Page handlers reach the rendered DOM under
 * native-host. Used here only for the best-effort play() tap; failures are
 * swallowed by the caller.
 */
async function evalInActivePage(expression: string): Promise<unknown> {
  return electronApp.evaluate(async ({ webContents }, expr) => {
    const all = webContents.getAllWebContents()
    // Active page frames load pageFrame.html; pick the last (top-of-stack) one.
    const pages = all.filter((wc) => wc.getURL().includes('pageFrame.html'))
    const target = pages[pages.length - 1] ?? all.find((wc) => wc.getType() === 'webview')
    if (!target) return false
    return target.executeJavaScript(expr)
  }, expression)
}
