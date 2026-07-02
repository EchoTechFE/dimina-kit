/**
 * Hot-reload stress test: 30 rapid recompiles at a ~1s cadence against the
 * SAME open project, asserting the simulator never goes blank, never
 * crashes, and the native-host render path (render-host webviews / the
 * simulator WebContentsView) doesn't leak across the run.
 *
 * Each round rewrites `pages/home/home.wxml` in the checked-in `tabbar-app`
 * fixture with a round-unique visible marker. chokidar picks up the write,
 * dmcc rebuilds, and the render-host guest re-renders the page — the same
 * chain editor-hot-reload.spec.ts exercises for a single save, run here back
 * to back. We deliberately do NOT assert an exact rebuild count: the
 * rebuild-scheduler coalesces writes that land within its debounce window
 * into one trailing build (see devkit's rebuild-scheduler.ts and the
 * writeUntilPredicate contract in watch-rebuild.testutil.ts), so the only
 * sound assertion is "every round's marker eventually renders and the
 * simulator stays alive throughout" — not "exactly 30 builds ran".
 *
 * MANUAL-ONLY / opt-in: this test mutates the SHARED `fixtures/tabbar-app`
 * directory that several other specs (native-host-render.spec.ts,
 * prewarm-pool.spec.ts, native-host-switchtab-rerender.spec.ts, …) read
 * concurrently under the default `pnpm test:e2e` full-suite run (workers=3
 * locally). Repeatedly rewriting a shared fixture while those specs are
 * reading/compiling it would race and produce spurious failures unrelated to
 * this test. It is gated behind `HOT_RELOAD_STRESS=1` so it never runs as
 * part of the default suite (nor CI, which does not invoke playwright at
 * all — see .github/workflows/ci.yml) and must be launched deliberately:
 *
 *   HOT_RELOAD_STRESS=1 pnpm --filter @dimina-kit/devtools test:e2e hot-reload-stress
 *
 * Leak thresholds (webContents-count slack, memory ratio, memory ceiling)
 * are environment-overridable — see the constants below. The absolute
 * memory ceiling in particular is a PLACEHOLDER pending a real run: the
 * per-round `console.log` lines print `workingSetSizeKb` /
 * `webContentsCount` samples so a real run's numbers can tighten it.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  openProjectInUI,
  waitForSimulatorWebview,
  closeProject,
  pollUntil,
  evalInSimulator,
  findButtonByText,
} from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')
const HOME_WXML_PATH = path.join(FIXTURE_DIR, 'pages', 'home', 'home.wxml')

// ── Tunables (env-overridable) ──────────────────────────────────────────────

const WARMUP_ROUNDS = 3
const ROUNDS = 30
/** Sleep between rounds — the "every ~1s" cadence the spec is named for. */
const ROUND_INTERVAL_MS = 1000
/** Per-round cap on waiting for that round's marker to render. Generous: a
 * real rebuild+respawn+paint is expected to land in a couple of seconds (see
 * editor-hot-reload.spec.ts's HOT_RELOAD_WINDOW_MS), so hitting this cap on
 * every round would itself signal a real regression, not just flakiness. */
const ROUND_TIMEOUT_MS = 15_000
/** Sub-budget between rewrite retries inside a round's timeout window — a
 * dropped chokidar inotify event (the one flaky moving part per devkit's
 * watch-rebuild.testutil.ts) gets a fresh write instead of just waiting
 * longer on an event that already got lost. */
const REWRITE_RETRY_MS = 4_000

/** webContents count is allowed to drift by this much above baseline before
 * it's treated as a leak signal (small orphan-view churn is expected; a
 * steady climb across rounds is not). */
const WEBCONTENTS_COUNT_SLACK = Number(process.env.HOT_RELOAD_WEBCONTENTS_SLACK ?? 2)
/** Ratio of (avg of the last 5 rounds) / (avg of the first 5 rounds) browser-
 * process workingSetSize beyond which the run is considered leaking memory. */
const MEM_RATIO_THRESHOLD = Number(process.env.HOT_RELOAD_MEM_RATIO ?? 1.8)
/** Loose absolute ceiling on the final round's workingSetSize (KB) — a
 * gross-leak backstop, not the primary signal (the webContents count and the
 * head/tail ratio are). Calibrated from a real 30-round run on this machine:
 * the browser process peaked around 211 MB and trended DOWN over the run, so
 * ~2× peak leaves generous headroom for slower/heavier machines while still
 * catching a runaway leak. Override via HOT_RELOAD_MEM_CEILING_KB. */
const MEM_CEILING_KB = Number(process.env.HOT_RELOAD_MEM_CEILING_KB ?? 450_000)

let electronApp: ElectronApplication
let mainWindow: PwPage
let originalHomeWxml = ''

// ── Probes (mirrors editor-hot-reload.spec.ts / relaunch-resilience.spec.ts) ─

/**
 * Concatenated visible text of every render-host page guest. Returns '' when
 * no guest is ready yet (callers poll). Copied from editor-hot-reload.spec.ts
 * — screenshots can't capture nested webview content, so we read
 * `document.body.innerText` of each `pageFrame.html` guest directly in main.
 */
async function readRenderText(app: ElectronApplication): Promise<string> {
  try {
    return await app.evaluate(async ({ webContents }) => {
      const frames = webContents
        .getAllWebContents()
        .filter((wc) => !wc.isDestroyed() && wc.getURL().includes('pageFrame.html'))
      const texts: string[] = []
      for (const f of frames) {
        try {
          texts.push((await f.executeJavaScript('document.body.innerText')) as string)
        } catch {
          // guest navigating / not ready — skip
        }
      }
      return texts.join('\n---FRAME---\n')
    })
  } catch {
    return ''
  }
}

async function waitForRenderText(
  app: ElectronApplication,
  predicate: (text: string) => boolean,
  timeout: number,
): Promise<string> {
  return pollUntil(() => readRenderText(app), predicate, timeout, 400)
}

/**
 * Native readiness probe copied from relaunch-resilience.spec.ts:
 * `.device-shell-root` mounts only once SimulatorMiniApp.spawn() resolves,
 * and `.device-shell__webview` is exclusive to the native render path.
 */
async function getDeviceShellWebviewCount(app: ElectronApplication): Promise<number> {
  return evalInSimulator<number>(
    app,
    `(() => {
      if (!document.querySelector('.device-shell-root')) return 0
      return document.querySelectorAll('.device-shell__webview').length
    })()`,
  ).catch(() => 0)
}

/**
 * The simulator shell WCV's webContents id, or -1 when absent. Soft reload
 * (ready-then-swap) keeps ONE WebContentsView alive across recompiles, so this
 * id must stay constant through the whole stress run — an id change means a
 * round fell back to the hard teardown+rebuild path (or the shell died).
 */
async function getSimulatorShellWcId(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ webContents }) => {
    const shell = webContents
      .getAllWebContents()
      .find((wc) => !wc.isDestroyed() && wc.getURL().includes('simulator.html'))
    return shell ? shell.id : -1
  })
}

/** True if the simulator shell WCV or any render-host page guest crashed. */
async function anyGuestOrShellCrashed(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ webContents }) => {
    const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
    const shell = all.find((wc) => wc.getURL().includes('simulator.html'))
    const guests = all.filter((wc) => wc.getURL().includes('pageFrame.html'))
    return (shell ? shell.isCrashed() : false) || guests.some((wc) => wc.isCrashed())
  })
}

interface MemorySample {
  workingSetSizeKb: number
  webContentsCount: number
}

/**
 * Browser-process (main process) memory + total webContents count. `app`
 * here is the Electron `app` singleton inside the evaluate closure — distinct
 * from the outer `electronApp: ElectronApplication` Playwright handle.
 */
async function getMemorySample(electronApp: ElectronApplication): Promise<MemorySample> {
  return electronApp.evaluate(({ app, webContents }) => {
    const metrics = app.getAppMetrics()
    const browser = metrics.find((m) => m.type === 'Browser')
    return {
      workingSetSizeKb: browser?.memory.workingSetSize ?? 0,
      webContentsCount: webContents.getAllWebContents().length,
    }
  })
}

/** Basic right-panel / toolbar smoke, copied from devtools-panel.spec.ts. */
async function assertPanelBasics(mainWindow: PwPage): Promise<void> {
  expect(await findButtonByText(mainWindow, '普通编译')).toBe(true)
  await expect(mainWindow.getByRole('group', { name: '面板可见性' })).toBeVisible()
  await expect(mainWindow.getByTestId('layout-toolbar-toggle-simulator')).toBeVisible()

  const tabLabels = await mainWindow.evaluate(() => {
    const buttons = document.querySelectorAll('button')
    const labels: string[] = []
    buttons.forEach((btn) => {
      const text = btn.textContent?.trim()
      if (text && ['WXML', 'AppData', 'Storage'].includes(text)) labels.push(text)
    })
    return labels
  })
  expect(tabLabels).toEqual(expect.arrayContaining(['WXML', 'AppData', 'Storage']))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

/**
 * Rewrites `home.wxml` with a `data-attempt` value that changes byte
 * length/mtime on every retry (never rendered as visible text, so the
 * predicate keeps matching the same `marker`) — same rationale as devkit's
 * `writeUntilPredicate`: a dropped chokidar inotify event gets a fresh write
 * instead of a longer wait on an event that's already gone.
 */
function homeWxmlContent(marker: string, attempt: number): string {
  return [
    `<view class="page-marker page-home" data-attempt="${attempt}">${marker}</view>`,
    '<button class="btn nav-detail-btn" bindtap="goDetail" data-path="/pages/detail/detail">Go Detail</button>',
    '',
  ].join('\n')
}

/**
 * Write `marker` into home.wxml and wait for it to appear in the render-host
 * guest's text, re-writing (byte-different `data-attempt`) if a round's
 * budget elapses without the marker showing up. Returns whatever render text
 * was last observed — callers assert `.toContain(marker)` themselves so a
 * genuine failure (not just a dropped event) produces a clear diff.
 */
async function writeMarkerUntilRendered(
  app: ElectronApplication,
  marker: string,
  overallTimeoutMs: number,
  rewriteRetryMs: number,
): Promise<string> {
  const deadline = Date.now() + overallTimeoutMs
  let attempt = 0
  let text: string
  do {
    fs.writeFileSync(HOME_WXML_PATH, homeWxmlContent(marker, attempt))
    attempt += 1
    const waitBudget = Math.min(rewriteRetryMs, Math.max(300, deadline - Date.now()))
    text = await waitForRenderText(app, (t) => t.includes(marker), waitBudget)
  } while (!text.includes(marker) && Date.now() < deadline)
  return text
}

// ── Suite ────────────────────────────────────────────────────────────────

test.describe('Hot-reload stress (30 rapid recompiles)', () => {
  test.describe.configure({ mode: 'serial' })
  test.skip(
    !process.env.HOT_RELOAD_STRESS,
    'manual-only stress test — set HOT_RELOAD_STRESS=1 to run it explicitly (see file header: it mutates the shared tabbar-app fixture and must not race the default full-suite run)',
  )
  test.setTimeout(300_000)

  test.beforeAll(async () => {
    originalHomeWxml = fs.readFileSync(HOME_WXML_PATH, 'utf8')

    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `hot-reload-stress-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })

    electronApp = await _electron.launch({
      args: [appPath, 'auto', '--auto-port', '0', `--user-data-dir=${userDataDir}`],
      env: { ...process.env, NODE_ENV: 'test', DIMINA_NATIVE_HOST: '1', DIMINA_E2E_USER_DATA_DIR: userDataDir },
    })

    mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')

    // Off-screen + blurred so this doesn't steal focus / pop a visible window
    // while running headfully alongside other work (same as native-host-render.spec.ts).
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

    await openProjectInUI(mainWindow, FIXTURE_DIR, { waitMs: 20000 })
    await waitForSimulatorWebview(electronApp)
  })

  test.afterAll(async () => {
    // Restore the shared fixture FIRST, unconditionally — afterAll runs even
    // if the test body throws, so this is the single point that guarantees
    // the working tree is never left with a stress-test marker in it.
    try {
      if (originalHomeWxml) fs.writeFileSync(HOME_WXML_PATH, originalHomeWxml, 'utf8')
    } catch {
      // best-effort — surfaced separately by git status if this ever fails
    }
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('simulator survives 30 rapid recompiles without going blank, crashing, or leaking views', async () => {
    // Baseline: the home fixture must actually be rendering before any
    // mutation — otherwise a missing marker later would just mean "never
    // rendered", not "hot reload failed".
    const baselineText = await waitForRenderText(electronApp, (t) => t.includes('HOME PAGE'), 30000)
    expect(baselineText, 'home page must render its baseline marker before the stress loop starts').toContain(
      'HOME PAGE',
    )

    await assertPanelBasics(mainWindow)

    const runId = Date.now()

    // Warm up a few rounds so the FIRST recorded samples aren't polluted by
    // cold-start allocation noise (JIT warmup, first-compile caches, etc.).
    for (let w = 0; w < WARMUP_ROUNDS; w++) {
      const marker = `HOME PAGE warmup-${w}-${runId}`
      const text = await writeMarkerUntilRendered(electronApp, marker, ROUND_TIMEOUT_MS, REWRITE_RETRY_MS)
      expect(text, `warmup round ${w} marker should render`).toContain(marker)
      await sleep(300)
    }

    const baseline = await getMemorySample(electronApp)
    const baselineShellWcId = await getSimulatorShellWcId(electronApp)
    expect(baselineShellWcId, 'a live simulator shell must exist before the stress loop').toBeGreaterThan(0)
    console.log(
      `[hot-reload-stress] baseline workingSetSizeKb=${baseline.workingSetSizeKb} webContentsCount=${baseline.webContentsCount} shellWcId=${baselineShellWcId}`,
    )

    const samples: MemorySample[] = []

    for (let i = 0; i < ROUNDS; i++) {
      const marker = `HOME PAGE r${i}-${runId}`
      const text = await writeMarkerUntilRendered(electronApp, marker, ROUND_TIMEOUT_MS, REWRITE_RETRY_MS)
      expect(
        text,
        `round ${i}/${ROUNDS}: marker should appear in the render-host guest's text within ~${ROUND_TIMEOUT_MS}ms (with rewrite retries for dropped inotify events)`,
      ).toContain(marker)

      const shellWebviews = await getDeviceShellWebviewCount(electronApp)
      expect(
        shellWebviews,
        `round ${i}: DeviceShell should keep ≥1 render-host page webview mounted (not blank)`,
      ).toBeGreaterThanOrEqual(1)

      const visibility = await evalInSimulator<string>(electronApp, `document.visibilityState`).catch(() => '')
      expect(visibility, `round ${i}: simulator document should stay visible, not torn down`).toBe('visible')

      const crashed = await anyGuestOrShellCrashed(electronApp)
      expect(crashed, `round ${i}: no render-host guest or simulator shell should crash`).toBe(false)

      const shellWcId = await getSimulatorShellWcId(electronApp)
      expect(
        shellWcId,
        `round ${i}: the simulator shell WCV must be the SAME webContents across recompiles ` +
          '(soft reload swaps content inside the live shell; an id change means the round fell back to hard teardown+rebuild)',
      ).toBe(baselineShellWcId)

      const sample = await getMemorySample(electronApp)
      samples.push(sample)
      console.log(
        `[hot-reload-stress] round=${i} workingSetSizeKb=${sample.workingSetSizeKb} webContentsCount=${sample.webContentsCount}`,
      )

      await sleep(ROUND_INTERVAL_MS)
    }

    // Panel basics must still work after 30 rapid respawns, not just at boot.
    await assertPanelBasics(mainWindow)

    // ── Leak assertions ───────────────────────────────────────────────────
    const headSamples = samples.slice(0, 5)
    const tailSamples = samples.slice(-5)

    const maxTailWebContents = Math.max(...tailSamples.map((s) => s.webContentsCount))
    expect(
      maxTailWebContents,
      `webContents count should stay within baseline+slack (baseline=${baseline.webContentsCount}, ` +
        `slack=${WEBCONTENTS_COUNT_SLACK}, tail samples=${JSON.stringify(tailSamples.map((s) => s.webContentsCount))}) — ` +
        'a count that keeps climbing means render-host guests / the simulator WCV are not being disposed on rebuild',
    ).toBeLessThanOrEqual(baseline.webContentsCount + WEBCONTENTS_COUNT_SLACK)

    const headAvgWc = average(headSamples.map((s) => s.webContentsCount))
    const tailAvgWc = average(tailSamples.map((s) => s.webContentsCount))
    expect(
      tailAvgWc - headAvgWc,
      `webContents count must not trend upward across ${ROUNDS} rounds (first-5 avg=${headAvgWc}, ` +
        `last-5 avg=${tailAvgWc}) — a rising trend is the clearest per-round view-leak signal`,
    ).toBeLessThanOrEqual(WEBCONTENTS_COUNT_SLACK)

    const headAvgMem = average(headSamples.map((s) => s.workingSetSizeKb))
    const tailAvgMem = average(tailSamples.map((s) => s.workingSetSizeKb))
    const memRatio = tailAvgMem / Math.max(1, headAvgMem)
    console.log(
      `[hot-reload-stress] memRatio=${memRatio.toFixed(3)} headAvgKb=${headAvgMem.toFixed(0)} tailAvgKb=${tailAvgMem.toFixed(0)}`,
    )
    expect(
      memRatio,
      `browser-process workingSetSize should not grow more than ${MEM_RATIO_THRESHOLD}x from the first 5 to ` +
        `the last 5 of ${ROUNDS} rapid recompiles (head avg=${headAvgMem.toFixed(0)}KB, tail avg=${tailAvgMem.toFixed(0)}KB) — ` +
        'threshold overridable via HOT_RELOAD_MEM_RATIO',
    ).toBeLessThan(MEM_RATIO_THRESHOLD)

    const lastSample = samples[samples.length - 1]
    expect(
      lastSample.workingSetSizeKb,
      `browser-process workingSetSize at the final round should stay under the gross-leak ceiling ` +
        `(${MEM_CEILING_KB}KB, ~2x the observed ~211MB peak; override via HOT_RELOAD_MEM_CEILING_KB)`,
    ).toBeLessThan(MEM_CEILING_KB)
  })
})
