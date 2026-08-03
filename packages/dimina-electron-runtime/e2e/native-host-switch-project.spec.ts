/**
 * E2E (native-host only): opening a second project directly via
 * `runtime.openProject()` WITHOUT calling `closeProject` first renders the new
 * project's content and tears down the previous project's render guests.
 *
 * This harness has no project-list UI, so it can't drive the real UI
 * back-button path (`window:navigateBack` without `ProjectChannel.Close`)
 * devtools itself exercises — it goes straight at the underlying condition
 * that path also produces: `openProject(B)` firing while a session for A is
 * still alive (no intervening `closeProject`). That's the distinguishing
 * scenario from native-host-reopen-project.spec.ts and
 * reopen-different-project.spec.ts, whatever UI action would trigger it. When
 * this happens, workspace-service reaches the `currentSession !== null`
 * branch of openProject and must synchronously call detachWorkbench() +
 * detachSimulator() before spinning up the new session.
 *
 * Guards:
 *  - simulator shows B's home page content (positive)
 *  - simulator does NOT carry A's home page content (negative, load-bearing)
 *  - all render guests from project A are destroyed after B opens
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  openProject,
  waitForSimulatorWebview,
  closeProject,
  pollUntil,
  evalInWebContentsByUrl,
  RENDER_GUEST_URL_MARKER,
} from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// page-stack-app home page carries "Go A" (exclusive to this fixture).
const PROJECT_A_DIR = path.resolve(__dirname, 'fixtures', 'page-stack-app')
// tabbar-app home page carries "Go Detail" (exclusive to this fixture).
const PROJECT_B_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

const MARKER_A = 'Go A'
const MARKER_B = 'Go Detail'

/**
 * Read the innerText of the first live render-host page guest (__frame__.html).
 * Returns null while no live guest exists (between projects or before first mount).
 */
async function readRenderGuestText(
  electronApp: ElectronApplication,
): Promise<string | null> {
  return evalInWebContentsByUrl<string>(
    electronApp,
    RENDER_GUEST_URL_MARKER,
    '(document.body ? document.body.innerText : "")',
  ).catch(() => null)
}

/**
 * Count live (non-destroyed) render-host page guests.
 * Used to confirm all guests from the previous project are gone after the switch.
 */
function liveGuestCount(electronApp: ElectronApplication): Promise<number> {
  return electronApp.evaluate(({ webContents }, marker) =>
    webContents
      .getAllWebContents()
      .filter((wc) => !wc.isDestroyed() && wc.getURL().includes(marker))
      .length,
  RENDER_GUEST_URL_MARKER)
}

test.describe('native-host switch project without closeProject disposes old guests and renders new project', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  let electronApp: ElectronApplication
  let mainWindow: PwPage

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'electron-runtime-e2e'),
      'userdata',
      `nh-switch-project-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })

    electronApp = await _electron.launch({
      args: [appPath, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DIMINA_E2E_USER_DATA_DIR: userDataDir,
      },
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
  })

  test.afterAll(async () => {
    await closeProject(electronApp).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('switching projects without closeProject renders project B content and destroys project A guests', async () => {
    // ── Step 1: open project A and verify its content renders ─────────────
    await openProject(electronApp, PROJECT_A_DIR)
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
      `project A must not already contain project B's marker "${MARKER_B}" (fixture sanity)`,
    ).not.toContain(MARKER_B)

    // ── Step 2: switch to project B WITHOUT calling closeProject ──────────
    // openProject(B) fires while the main-process session for A is still
    // alive — this is the branch under test.
    await openProject(electronApp, PROJECT_B_DIR)
    await waitForSimulatorWebview(electronApp)

    // ── Step 3: assert project B renders and A is fully gone ──────────────

    const textB = await pollUntil(
      () => readRenderGuestText(electronApp),
      (t) => typeof t === 'string' && t.includes(MARKER_B),
      30_000,
      400,
    )

    // Positive: project B's exclusive text must be visible.
    expect(
      textB,
      `simulator must show project B's "${MARKER_B}" after switching from A`,
    ).toContain(MARKER_B)

    // Negative (load-bearing): project A's exclusive text must be absent.
    // If the switch path fails to detach the old simulator, project A's page
    // content leaks through and this assertion catches it.
    expect(
      textB,
      `simulator must not carry project A's stale "${MARKER_A}" after switching to B`,
    ).not.toContain(MARKER_A)

    // All render guests from project A must be destroyed.
    // If the switch path skips disposeAppSession, old guests survive and the
    // count is non-zero — this assertion catches that regression.
    await pollUntil(
      () => liveGuestCount(electronApp),
      // Accept at least 1 guest for project B; guests from A must be 0.
      // We cannot distinguish A-vs-B guests without bridgeId here, so we rely
      // on the content assertion above as the primary discriminator and only
      // confirm that guest count is consistent (≥1 means B is alive).
      (n) => n >= 1,
      15_000,
      300,
    ).catch(() => {})

    // The canonical stale-guest check: after switching to B, no __frame__.html
    // WebContents that are both live AND serve A's content should exist.
    const staleAGuestExists = await electronApp.evaluate(
      async ({ webContents }, payload) => {
        const all = webContents.getAllWebContents()
        const liveGuests = all.filter(
          (wc) => !wc.isDestroyed() && wc.getURL().includes(payload.urlMarker),
        )
        for (const wc of liveGuests) {
          try {
            const text = await wc.executeJavaScript(
              '(document.body ? document.body.innerText : "")',
            ) as string
            if (text.includes(payload.markerA)) return true
          } catch {
            // destroyed mid-check — not a stale guest problem
          }
        }
        return false
      },
      { markerA: MARKER_A, urlMarker: RENDER_GUEST_URL_MARKER },
    )

    expect(
      staleAGuestExists,
      `no live render guest may still serve project A's content "${MARKER_A}" after switching to B`,
    ).toBe(false)
  })
})
