/**
 * The popover "重新编译" button must trigger a REAL compiler recompile, not
 * just re-attach the simulator to whatever was compiled before (微信开发者
 * 工具语义: 重新编译 = 重新编译 + 回到启动页重启).
 *
 * Two user-visible contracts are covered:
 *  - with "自动编译" off, source changes appear only after clicking 重新编译,
 *    proving the button performs a real compiler rebuild;
 *  - changing the compile start page from HOME to CART before clicking
 *    重新编译 relaunches the simulator at CART, matching 微信开发者工具.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { WebSocket } from 'ws'
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
import { AutomationChannel, WorkbenchSettingsChannel } from '../src/shared/ipc-channels'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')
const HOME_WXML = path.join(FIXTURE_DIR, 'pages', 'home', 'home.wxml')
const SENTINEL = 'RECOMPILE-BUTTON-SENTINEL'

let electronApp: ElectronApplication
let mainWindow: PwPage
let originalWxml = ''
let autoPort = 0

function wsCall<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 12000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${autoPort}`)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`wsCall ${method} timed out`))
    }, timeoutMs)
    ws.on('open', () => ws.send(JSON.stringify({ id: 'recompile-route', method, params })))
    ws.on('message', (raw) => {
      let msg: { id?: string; result?: unknown; error?: { message?: string } }
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.id !== 'recompile-route') return
      clearTimeout(timer)
      ws.close()
      if (msg.error) reject(new Error(msg.error.message || 'rpc error'))
      else resolve(msg.result as T)
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function readActivePageText(): Promise<string> {
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
async function clickRecompileInPopover(startPage?: string): Promise<void> {
  const compileDropdown = mainWindow.getByRole('button', { name: /普通编译/ })
  await compileDropdown.waitFor({ timeout: 10000 })
  await compileDropdown.click()

  await pollUntil(
    () => electronApp.evaluate(async ({ webContents }) => {
      const popover = webContents.getAllWebContents().find((wc) => wc.getURL().includes('entries/popover'))
      if (!popover || popover.isLoading()) return false
      return popover.executeJavaScript(`
        Array.from(document.querySelectorAll('button'))
          .some((button) => (button.textContent || '').includes('重新编译'))
      `).catch(() => false)
    }),
    (ready) => ready === true,
    10000,
    200,
  )

  if (startPage) {
    await electronApp.evaluate(async ({ webContents }, selectedStartPage) => {
      const popover = webContents.getAllWebContents().find((wc) => wc.getURL().includes('entries/popover'))
      if (!popover) throw new Error('popover webContents not found')
      await popover.executeJavaScript(`
        (() => {
          const select = document.querySelector('select')
          if (!select) throw new Error('启动页面 select not found in popover')
          const startPage = ${JSON.stringify(selectedStartPage)}
          if (!Array.from(select.options).some((option) => option.value === startPage)) {
            throw new Error('启动页面 option not found: ' + startPage)
          }
          select.value = startPage
          select.dispatchEvent(new Event('change', { bubbles: true }))
          return select.value
        })()
      `)
    }, startPage)

    // React applies the controlled Select update asynchronously. Click in a
    // separate task so handleRelaunch observes the new config, matching a real
    // user selecting a compile mode before pressing 重新编译.
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  await electronApp.evaluate(async ({ webContents }) => {
    const popover = webContents.getAllWebContents().find((wc) => wc.getURL().includes('entries/popover'))
    if (!popover) throw new Error('popover webContents not found')
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

test.describe('popover 重新编译 rebuilds and relaunches at the selected start page', () => {
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

    autoPort = await pollUntil(
      () => ipcInvoke<number | null>(mainWindow, AutomationChannel.GetPort),
      (port) => typeof port === 'number' && port > 0,
      10000,
      100,
    ) as number

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
      () => readActivePageText(),
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
    const stillStale = await readActivePageText()
    expect(
      stillStale.includes(SENTINEL),
      'autoBuild is off — the sentinel must NOT appear without an explicit recompile',
    ).toBe(false)

    // ── Click 重新编译 in the popover — this must trigger a REAL recompile,
    // not just a reattach to the stale build. ────────────────────────────────
    await clickRecompileInPopover()

    const afterRecompile = await pollUntil(
      () => readActivePageText(),
      (txt) => txt.includes(SENTINEL),
      30000,
      500,
    )
    expect(
      afterRecompile,
      '重新编译 must recompile the edited source and reload onto it — a reattach-only implementation would still show the stale build',
    ).toContain(SENTINEL)
  })

  test('changing the compile start page then clicking 重新编译 opens that page', async () => {
    const routeBefore = await pollUntil(
      () => wsCall<{ path?: string }>('App.getCurrentPage').catch(() => null),
      (page) => !!page?.path?.includes('pages/home/home'),
      20000,
      500,
    )
    expect(routeBefore?.path).toContain('pages/home/home')

    const before = await pollUntil(
      () => readActivePageText(),
      (txt) => txt.includes('HOME PAGE'),
      20000,
      400,
    )
    expect(before).toContain('HOME PAGE')

    await clickRecompileInPopover('pages/cart/cart')

    const routeAfter = await pollUntil(
      () => wsCall<{ path?: string }>('App.getCurrentPage').catch(() => null),
      (page) => !!page?.path?.includes('pages/cart/cart'),
      30000,
      500,
    )
    expect(
      routeAfter?.path,
      '重新编译后的 active page route must be pages/cart/cart instead of the previous HOME route',
    ).toContain('pages/cart/cart')

    const afterRecompile = await pollUntil(
      () => readActivePageText(),
      (txt) => txt.includes('CART PAGE'),
      30000,
      500,
    )
    expect(
      afterRecompile,
      '首页 → 选择 pages/cart/cart → 重新编译 must relaunch the simulator at CART instead of retaining HOME',
    ).toContain('CART PAGE')
    expect(afterRecompile).not.toContain('HOME PAGE')
  })
})
