/**
 * The popover "重新编译" button must trigger a REAL compiler recompile, not
 * just re-attach the simulator to whatever was compiled before (微信开发者
 * 工具语义: 重新编译 = 重新编译 + 回到启动页重启).
 *
 * Reproduction: turn "自动编译" off (compile.autoBuild = false) so opening the
 * project never starts a file watcher, open the tabbar-app fixture, edit
 * home.wxml to inject a sentinel, confirm the sentinel does NOT appear on its
 * own (no watcher = no auto-rebuild), then click "重新编译" in the compile
 * popover and confirm the sentinel DOES appear — proof the button actually
 * recompiled instead of only re-mounting the stale build.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  openProjectInUI,
  closeProject,
  pollUntil,
  ipcInvoke,
  waitForSimulatorWebview,
  evalInSimulator,
  evalInWebContentsByUrl,
  RENDER_GUEST_URL_MARKER,
} from './helpers'
import { WorkbenchSettingsChannel } from '../src/shared/ipc-channels'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')
const HOME_WXML = path.join(FIXTURE_DIR, 'pages', 'home', 'home.wxml')
const SENTINEL = 'RECOMPILE-BUTTON-SENTINEL'

let electronApp: ElectronApplication
let mainWindow: PwPage
let originalWxml = ''

async function readHomePageText(): Promise<string> {
  return evalInWebContentsByUrl<string>(
    electronApp,
    RENDER_GUEST_URL_MARKER,
    'document.body.innerText',
  ).catch(() => '')
}

/**
 * Open the compile popover and click "重新编译" inside it. The popover is a
 * SEPARATE top-level WebContents (see overlay-panels-view.ts, loads
 * `entries/popover/index.html`) — it is not part of the main window DOM, so
 * the button must be found and clicked via `electronApp.evaluate` against
 * that WebContents specifically.
 */
async function clickRecompileInPopover(): Promise<void> {
  const compileDropdown = mainWindow.getByRole('button', { name: /普通编译/ })
  await compileDropdown.waitFor({ timeout: 10000 })
  await compileDropdown.click()

  await pollUntil(
    () => electronApp.evaluate(({ webContents }) =>
      webContents.getAllWebContents().some((wc) => wc.getURL().includes('entries/popover'))),
    (present) => present === true,
    10000,
    200,
  )

  await electronApp.evaluate(async ({ webContents }) => {
    const popover = webContents.getAllWebContents().find((wc) => wc.getURL().includes('entries/popover'))
    if (!popover) throw new Error('popover webContents not found')
    if (popover.isLoading()) throw new Error('popover webContents still loading')
    await popover.executeJavaScript(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('button'))
        const target = buttons.find((b) => (b.textContent || '').includes('重新编译'))
        if (!target) throw new Error('重新编译 button not found in popover')
        target.click()
      })()
    `)
  })
}

test.describe('popover 重新编译 button recompiles stale source (autoBuild off)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    originalWxml = fs.readFileSync(HOME_WXML, 'utf8')
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e'),
      'userdata',
      `recompile-btn-${process.pid}`,
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

    // Turn autoBuild off BEFORE opening the project, so openProject never
    // starts a chokidar watcher — the only way to isolate "the button itself
    // recompiled" from "the watcher already picked up the edit".
    const settings = await ipcInvoke<{ compile: { autoBuild: boolean }, [k: string]: unknown }>(
      mainWindow,
      WorkbenchSettingsChannel.Get,
    )
    await ipcInvoke(mainWindow, WorkbenchSettingsChannel.Save, {
      ...settings,
      compile: { ...settings.compile, autoBuild: false },
    })

    await openProjectInUI(mainWindow, FIXTURE_DIR, { waitMs: 20000 })
    await waitForSimulatorWebview(electronApp)

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
    fs.writeFileSync(HOME_WXML, originalWxml)
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('clicking 重新编译 recompiles the edited source and shows it — no auto-rebuild happens first', async () => {
    // ── Sanity: the entry page renders its pre-edit content. ────────────────
    const initial = await pollUntil(
      () => readHomePageText(),
      (txt) => txt.includes('HOME PAGE'),
      20000,
      400,
    )
    expect(initial).toContain('HOME PAGE')

    // ── Edit the source on disk WITHOUT going through the app — autoBuild is
    // off, so no watcher exists to pick this up. ────────────────────────────
    fs.writeFileSync(
      HOME_WXML,
      originalWxml.replace('HOME PAGE', `HOME PAGE ${SENTINEL}`),
    )

    // ── Confirm the edit does NOT surface on its own within a generous
    // window — proves there is no live auto-compile in this configuration. ──
    await new Promise((resolve) => setTimeout(resolve, 8000))
    const stillStale = await readHomePageText()
    expect(
      stillStale.includes(SENTINEL),
      'autoBuild is off — the sentinel must NOT appear without an explicit recompile',
    ).toBe(false)

    // ── Click 重新编译 in the popover — this must trigger a REAL recompile,
    // not just a reattach to the stale build. ────────────────────────────────
    await clickRecompileInPopover()

    const afterRecompile = await pollUntil(
      () => readHomePageText(),
      (txt) => txt.includes(SENTINEL),
      30000,
      500,
    )
    expect(
      afterRecompile,
      '重新编译 must recompile the edited source and reload onto it — a reattach-only implementation would still show the stale build',
    ).toContain(SENTINEL)
  })
})
