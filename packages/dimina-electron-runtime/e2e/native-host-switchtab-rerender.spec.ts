/**
 * E2E (native-host): a tab keeps its rendered content when you switchTab away
 * and back. Guards the render-host reload regression — the device-shell mount
 * list must keep a STABLE DOM order so React never reparents (and thus Electron
 * never reloads) a hidden tab's `<webview>` guest. A reload would drop the
 * already-rendered DOM and, since render data is not re-pushed on reload, leave
 * the tab blank on return.
 *
 * Drives the same launch boilerplate as native-host-page-stack.spec.ts, on the
 * tabbar-app fixture (home/cart/me), via `__diminaE2eHooks` instead of a WS
 * automation server.
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  openProject, waitForSimulatorWebview, closeProject, pollUntil,
  evalInSimulator, evalInWebContentsByUrl, getCurrentPage, callWxMethod,
  waitForServicePageReady,
} from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')
const TABS = ['pages/home/home', 'pages/cart/cart', 'pages/me/me']

let electronApp: ElectronApplication
let mainWindow: PwPage

function visibleBridgeId(): Promise<string | null> {
  return evalInSimulator<string | null>(electronApp, `(() => {
    const wvs = Array.from(document.querySelectorAll('.device-shell__webview'));
    const visible = wvs.find((w) => getComputedStyle(w).display !== 'none');
    if (!visible) return null;
    const m = (visible.getAttribute('src') || '').match(/[?&]bridgeId=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  })()`).catch(() => null)
}
async function visibleElementCount(): Promise<number> {
  const bridgeId = await visibleBridgeId()
  if (!bridgeId) return 0
  const res = await evalInWebContentsByUrl<string>(electronApp, 'bridgeId=' + bridgeId,
    `(() => { const b = document.body; return b ? String(b.querySelectorAll('*').length) : '0' })()`).catch(() => '0')
  return parseInt(res, 10) || 0
}
async function switchTabTo(route: string): Promise<void> {
  await callWxMethod(electronApp, 'switchTab', [{ url: '/' + route }])
}
async function waitActive(sub: string): Promise<void> {
  await pollUntil(() => getCurrentPage(electronApp).catch(() => null),
    (r) => !!r && typeof r.path === 'string' && r.path.includes(sub), 15000, 300)
}

test.describe('native-host switchTab keeps rendered content on return', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'electron-runtime-e2e'),
      'userdata', `nh-switch-rerender-${process.pid}`)
    fs.mkdirSync(userDataDir, { recursive: true })
    electronApp = await _electron.launch({
      args: [appPath, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, NODE_ENV: 'test', DIMINA_E2E_USER_DATA_DIR: userDataDir },
    })
    mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isVisible()) await new Promise<void>((r) => { win.once('show', r); setTimeout(r, 5000) })
      if (win) { win.setPosition(-2000, -2000); win.blur() }
    })
    await openProject(electronApp, FIXTURE_DIR)
    await waitForSimulatorWebview(electronApp)
    await pollUntil(() => evalInSimulator<number>(electronApp,
      `(() => document.querySelectorAll('.device-shell__webview').length)()`).catch(() => 0), (n) => n >= 1, 30000, 400)
    // The route APIs resolve against the SERVICE host's own page stack, which is still empty for a few hundred ms after the render guest mounts.
    // Navigating inside that window throws in the mini-app framework.
    await waitForServicePageReady(electronApp)
    await waitActive('pages/home/home')
  })
  test.afterAll(async () => { await closeProject(electronApp).catch(() => {}); await electronApp?.close().catch(() => {}) })

  test('every tab still has DOM content after two away-and-back rounds', async () => {
    // First-visit baseline: each tab renders some content.
    const baseline: Record<string, number> = {}
    for (const tab of TABS) {
      await switchTabTo(tab); await waitActive(tab)
      const els = await pollUntil(visibleElementCount, (n) => n > 0, 15000, 400)
      baseline[tab] = els
      expect(els, `${tab} should render content on first visit`).toBeGreaterThan(0)
    }
    // Return rounds: content must persist (the reload regression blanked these).
    for (let round = 0; round < 2; round++) {
      for (const tab of TABS) {
        await switchTabTo(tab); await waitActive(tab)
        await new Promise((r) => setTimeout(r, 800))
        const els = await visibleElementCount()
        expect(els, `${tab} must keep content on return (round ${round}); was blank=${els === 0}`).toBeGreaterThan(0)
      }
    }
  })
})
