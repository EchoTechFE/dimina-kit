/**
 * Resource-census guard for the recompile → soft-reload churn cycle (default
 * suite, real Electron). Each round REALLY rewrites the project's home.wxml
 * (round-unique visible marker) and waits for the new content to render; the
 * assertions are exact-ledger equality, not memory thresholds:
 *
 * - after 5 rounds the bridge router's resource census (`__diminaResourceCensus`)
 *   must return EXACTLY to the post-open baseline — every superseded session's
 *   bindings, pending API calls and shared-wc teardown hooks are gone;
 * - the simulator shell webContents id never changes (every round took the
 *   soft-reload path — an id change means a hard teardown+rebuild slipped in);
 * - the total webContents population returns to its baseline count;
 * - after close-project the ledger deep-equals the PRE-OPEN snapshot
 *   (open/close teardown symmetry — the reopen-residue bug class);
 * - the fixtures' auto MaxListenersExceededWarning gate covers the whole test.
 *
 * The project is a THROWAWAY temp copy of the tabbar-app fixture, so this can
 * run inside the default parallel suite without mutating shared fixtures
 * (unlike the manual-only hot-reload-stress spec).
 */
import { expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import type { ElectronApplication } from '@playwright/test'
import { test } from './fixtures'
import {
  closeProject,
  openProjectInUI,
  pollUntil,
  waitForSimulatorWebview,
  waitSimulatorReady,
} from './helpers'
import { settleBridgeCensus } from './resource-guards'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SOURCE_FIXTURE = path.resolve(__dirname, 'fixtures', 'tabbar-app')

const ROUNDS = 5
/** Per-round cap on waiting for the round's marker to render. */
const ROUND_TIMEOUT_MS = 15_000
/** Rewrite retry budget inside a round (byte-different re-write on a dropped watch event). */
const REWRITE_RETRY_MS = 5_000

function homeWxmlContent(marker: string, attempt: number): string {
  return [
    `<view class="page-marker page-home" data-attempt="${attempt}">${marker}</view>`,
    '<button class="btn nav-detail-btn" bindtap="goDetail" data-path="/pages/detail/detail">Go Detail</button>',
    '',
  ].join('\n')
}

/** Concatenated `document.body.innerText` of every render-host guest. */
async function readRenderText(app: ElectronApplication): Promise<string> {
  try {
    return await app.evaluate(async ({ webContents }) => {
      const frames = webContents
        .getAllWebContents()
        // Skip loading frames: executeJavaScript on a loading wc queues one
        // did-stop-loading waiter per poll (MaxListeners pile-up under churn).
        .filter((wc) => !wc.isDestroyed() && !wc.isLoading() && wc.getURL().includes('pageFrame.html'))
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

async function writeMarkerUntilRendered(
  app: ElectronApplication,
  homeWxmlPath: string,
  marker: string,
): Promise<string> {
  const deadline = Date.now() + ROUND_TIMEOUT_MS
  let attempt = 0
  let text: string
  do {
    fs.writeFileSync(homeWxmlPath, homeWxmlContent(marker, attempt))
    attempt += 1
    const waitBudget = Math.min(REWRITE_RETRY_MS, Math.max(300, deadline - Date.now()))
    text = await pollUntil(() => readRenderText(app), (t) => t.includes(marker), waitBudget, 400)
  } while (!text.includes(marker) && Date.now() < deadline)
  return text
}

async function simulatorShellWcId(app: ElectronApplication): Promise<number | null> {
  return app.evaluate(({ webContents }) => {
    const shell = webContents
      .getAllWebContents()
      .find((wc) => !wc.isDestroyed() && wc.getURL().includes('simulator.html'))
    return shell?.id ?? null
  })
}

async function webContentsCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ webContents }) => webContents.getAllWebContents().length)
}

test.describe('soft-reload resource census', () => {
  test.describe.configure({ mode: 'serial' })

  let projectDir: string

  test.beforeAll(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-tabbar-'))
    fs.cpSync(SOURCE_FIXTURE, projectDir, { recursive: true })
  })

  test.afterAll(() => {
    if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true })
  })

  test('5 recompiles return the bridge ledger exactly to baseline', async ({ electronApp, mainWindow }) => {
    test.setTimeout(180_000)
    const homeWxmlPath = path.join(projectDir, 'pages', 'home', 'home.wxml')

    // Clean slate: close whatever a previous spec in this worker left open,
    // then snapshot the pre-open ledger for the close-symmetry assertion.
    await closeProject(mainWindow)
    const preOpen = await settleBridgeCensus(electronApp, () => true)

    await openProjectInUI(mainWindow, projectDir)
    await waitForSimulatorWebview(electronApp)
    await waitSimulatorReady(electronApp)

    // Settle the first session fully (root page booted, no churn in flight)
    // before taking the baseline the rounds must return to.
    const baseline = await settleBridgeCensus(
      electronApp,
      (census) => census.appSessions === preOpen.appSessions + 1,
    )
    const baselineShellWcId = await simulatorShellWcId(electronApp)
    expect(baselineShellWcId, 'a live simulator shell must exist after open').not.toBeNull()
    const baselineWcCount = await webContentsCount(electronApp)

    for (let round = 0; round < ROUNDS; round++) {
      const marker = `CENSUS_R${round}_${Date.now()}`
      const text = await writeMarkerUntilRendered(electronApp, homeWxmlPath, marker)
      expect(text, `round ${round} marker must render`).toContain(marker)
    }

    // The ledger — sessions, wc bindings, pending API calls, shared-wc
    // teardown hooks — must return EXACTLY to baseline once the last
    // superseded session's async teardown tail settles.
    const after = await settleBridgeCensus(
      electronApp,
      (census) => JSON.stringify(census) === JSON.stringify(baseline),
    )
    expect(after).toEqual(baseline)

    expect(
      await simulatorShellWcId(electronApp),
      'shell wc id must survive every round (soft reload, not rebuild)',
    ).toBe(baselineShellWcId)
    expect(
      await webContentsCount(electronApp),
      'webContents population must return to baseline',
    ).toBe(baselineWcCount)

    // Open/close teardown symmetry: closing the project must return the
    // ledger to the PRE-OPEN snapshot (the reopen-residue bug class).
    await closeProject(mainWindow)
    const postClose = await settleBridgeCensus(
      electronApp,
      (census) => JSON.stringify(census) === JSON.stringify(preOpen),
    )
    expect(postClose).toEqual(preOpen)
  })
})
