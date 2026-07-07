/**
 * E2E: reopening with a different project renders the new project's content
 * in the simulator, not residual content from the previously closed project.
 *
 * Guards the contract: open project A → close → open project B → simulator
 * must show B's home page, not A's. The negative assertion (A's unique text
 * must not appear after switching to B) is the load-bearing discriminator.
 *
 * Fixtures used (both exist in e2e/fixtures/):
 *  A — tabbar-app    (appid: devtools_tabbar_fixture)
 *      home page carries "Go Detail" button (class nav-detail-btn)
 *  B — page-stack-app (appid: devtools_page_stack_fixture)
 *      home page carries "Go A" / "Go B" buttons (class nav-a-btn / nav-b-btn)
 *
 * The two apps share the same home page label ("HOME PAGE") but differ in
 * their navigation buttons. "Go Detail" is exclusive to A; "Go A" is
 * exclusive to B. Reading document.body.innerText from the active
 * pageFrame.html render-host guest captures both positive and negative
 * evidence with zero dependency on appId internals.
 */
import { test, expect } from './fixtures'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  openProjectInUI,
  closeProject,
  pollUntil,
  evalInWebContentsByUrl,
  waitForSimulatorWebview,
} from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PROJECT_A_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')
const PROJECT_B_DIR = path.resolve(__dirname, 'fixtures', 'page-stack-app')

// Text that appears ONLY on project A's home page.
const MARKER_A = 'Go Detail'
// Text that appears ONLY on project B's home page.
const MARKER_B = 'Go A'

/**
 * Read the innerText of the first live render-host page guest (pageFrame.html).
 * Returns null while no live guest exists (between projects or before first mount).
 *
 * pageFrame.html is the exclusive URL pattern for the native-host render-host
 * <webview> guests; evalInWebContentsByUrl finds the first matching live WC
 * and executes JS in its main world. body.innerText includes all text rendered
 * by Vue into the WXML slot tree.
 */
async function readRenderGuestText(
  electronApp: import('@playwright/test').ElectronApplication,
): Promise<string | null> {
  return evalInWebContentsByUrl<string>(
    electronApp,
    'pageFrame.html',
    '(document.body ? document.body.innerText : "")',
  ).catch(() => null)
}

/**
 * Count live (non-destroyed) render-host page guests.
 * Used to confirm all guests from the previous project are gone before
 * opening the next project, so a lingering stale guest cannot satisfy
 * the positive content assertion prematurely.
 */
async function liveGuestCount(
  electronApp: import('@playwright/test').ElectronApplication,
): Promise<number> {
  return electronApp.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((wc) => !wc.isDestroyed() && wc.getURL().includes('pageFrame.html'))
      .length,
  )
}

test.describe('simulator content after close-reopen with a different project', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.afterEach(async ({ mainWindow }) => {
    // Best-effort teardown so the next test starts from the project list.
    await closeProject(mainWindow).catch(() => {})
  })

  test('simulator shows project B content, not project A residue, after close-reopen', async ({
    mainWindow,
    electronApp,
  }) => {
    // ── Step 1: open project A and verify its content renders ─────────────
    await openProjectInUI(mainWindow, PROJECT_A_DIR, { waitMs: 60_000 })
    await waitForSimulatorWebview(electronApp)

    const textA = await pollUntil(
      () => readRenderGuestText(electronApp),
      (t) => typeof t === 'string' && t.includes(MARKER_A),
      30_000,
      400,
    )

    expect(
      textA,
      `project A's simulator home page must contain "${MARKER_A}"`,
    ).toContain(MARKER_A)

    expect(
      textA,
      `project A's simulator must not already contain project B's marker "${MARKER_B}" (fixture sanity)`,
    ).not.toContain(MARKER_B)

    // ── Step 2: close project A ───────────────────────────────────────────
    await closeProject(mainWindow)

    // Confirm all render-host guests from project A are destroyed before
    // opening the next project. A stale live guest from A whose positive text
    // check happens to pass would produce a false-green on the assertion below.
    await pollUntil(
      () => liveGuestCount(electronApp),
      (n) => n === 0,
      15_000,
      300,
    ).catch(() => {
      // Non-blocking: if guests linger past the deadline the next step's negative
      // assertion ("Go Detail" must be absent) will catch the residue bug.
    })

    // ── Step 3: open project B and assert clean content ───────────────────
    await openProjectInUI(mainWindow, PROJECT_B_DIR, { waitMs: 60_000 })
    await waitForSimulatorWebview(electronApp)

    const textB = await pollUntil(
      () => readRenderGuestText(electronApp),
      (t) => typeof t === 'string' && t.includes(MARKER_B),
      30_000,
      400,
    )

    // Positive: project B's unique home page text must be present.
    expect(
      textB,
      `simulator must show project B's "${MARKER_B}" after reopening with a different project`,
    ).toContain(MARKER_B)

    // Negative: project A's unique text must be absent. This is the
    // load-bearing assertion — if the simulator carries residual content from
    // project A, this fails and the bug is caught.
    expect(
      textB,
      `simulator must not show project A's stale "${MARKER_A}" after switching to project B`,
    ).not.toContain(MARKER_A)
  })
})
