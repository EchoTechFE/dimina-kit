/**
 * E2E: the simulator RENDERER actually runs the native-host path (DeviceShell +
 * render-host <webview>s), and the automation-equivalent introspection hooks
 * (`getCurrentPage`/`getPageStack`/`getPageData`/`callWxMethod`, see
 * electron-entry.js) drive/read the real running page end to end.
 *
 * The render-host page content lives in a nested, cross-process <webview> whose
 * inner document the simulator context can't read, so we assert the reachable,
 * DISCRIMINATING facts: DeviceShell's `.device-shell-root` mounts and at least
 * one `.device-shell__webview` (a class the default dimina-fe path never emits)
 * is created with a render-host `src`. That proves the preload installed the
 * native-host bridge, SimulatorMiniApp.spawn() resolved, and DeviceShell painted.
 *
 * Split from devtools' original native-host-render.spec.ts: that file's
 * WXML/AppData/Storage PANEL tests, its element-inspection test, and its
 * console-forward-to-automation-WS test are devtools' own panel/automation-
 * server infrastructure (IPC channels devtools registers, not part of the
 * runtime's own bridge) — they stayed in packages/devtools/e2e/. Its default-
 * zoom-factor test also stayed there: `setZoomFactor` is never called
 * anywhere in this package's own src (grepped) — the "simulator defaults to
 * 0.85x zoom" behavior is devtools' own view-manager computing a fit-to-panel
 * zoom, not something the runtime itself has an opinion on. Only the
 * genuinely runtime-owned behaviour below moved here.
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
  evalInSimulator,
  getCurrentPage,
  getPageData,
  callWxMethod,
  RENDER_GUEST_URL_MARKER,
  waitForServicePageReady,
} from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

let electronApp: ElectronApplication
let mainWindow: PwPage

test.describe('native-host render path e2e', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'electron-runtime-e2e'),
      'userdata',
      `nh-render-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })

    electronApp = await _electron.launch({
      args: [appPath, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, NODE_ENV: 'test', DIMINA_E2E_USER_DATA_DIR: userDataDir },
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

    await openProject(electronApp, FIXTURE_DIR)
    await waitForSimulatorWebview(electronApp)
    // The route APIs resolve against the SERVICE host's own page stack, which is still empty for a few hundred ms after the render guest mounts.
    // Navigating inside that window throws in the mini-app framework.
    await waitForServicePageReady(electronApp)
  })

  test.afterAll(async () => {
    await closeProject(electronApp).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('renderer boots DeviceShell + render-host webviews under native-host', async () => {
    // DeviceShell mounts only after SimulatorMiniApp.spawn() resolves (IPC:
    // service host + resource server spin up first), so poll generously.
    const shellMounted = await pollUntil(
      () => evalInSimulator<boolean>(
        electronApp,
        `(() => !!document.querySelector('.device-shell-root'))()`,
      ).catch(() => false),
      (ok) => ok === true,
      25000,
      300,
    )
    expect(shellMounted, 'DeviceShell .device-shell-root should mount under native-host').toBe(true)

    // `.device-shell__webview` is exclusive to the native render path — the
    // default dimina-fe container never emits it. Load-bearing discriminator.
    const webviewCount = await pollUntil(
      () => evalInSimulator<number>(
        electronApp,
        `(() => document.querySelectorAll('.device-shell__webview').length)()`,
      ).catch(() => 0),
      (n) => n >= 1,
      25000,
      300,
    )
    expect(webviewCount, 'at least one render-host <webview> should exist').toBeGreaterThanOrEqual(1)

    // The webview points at the render host with a spawn-allocated bridgeId,
    // proving SimulatorMiniApp.spawn() + createRenderHostUrl ran.
    const src = await evalInSimulator<string>(
      electronApp,
      `(() => { const w = document.querySelector('.device-shell__webview'); return w ? (w.getAttribute('src') || '') : '' })()`,
    )
    expect(src).toMatch(/^dmb-resource:\/\//)
    expect(src).toContain(RENDER_GUEST_URL_MARKER)
    expect(src).toContain('bridgeId=')
  })

  test('getPageData returns the active page reactive data via the central accumulator', async () => {
    // The home fixture page declares `data: { pageName, counter, profile }`. Under
    // native-host this flows service→render and is tapped into the AppData
    // accumulator; getPageData reads it back.
    const full = await pollUntil(
      () => getPageData(electronApp, 'devtools_tabbar_fixture').catch(() => null),
      (r) => !!r && typeof r === 'object' && Object.keys(r as object).length > 0,
      30000,
      500,
    ) as Record<string, unknown>
    expect(full, 'getPageData should return the home page reactive data').toBeTruthy()
    expect(full.pageName).toBe('home')
    expect(full.counter).toBe(7)

    // Path traversal mirrors the default branch: nested + bracket paths resolve,
    // a missing key resolves to undefined (no throw).
    const nick = await getPageData(electronApp, 'devtools_tabbar_fixture', 'profile.nick')
    expect(nick).toBe('tester')
    const counter = await getPageData(electronApp, 'devtools_tabbar_fixture', 'counter')
    expect(counter).toBe(7)
    const bogus = await getPageData(electronApp, 'devtools_tabbar_fixture', '__definitely_missing_key__')
    expect(bogus).toBeUndefined()
  })

  test('getCurrentPage + callWxMethod switchTab navigate and read back the active page', async () => {
    const cur = await pollUntil(
      () => getCurrentPage(electronApp).catch(() => null),
      (r) => !!r && typeof r.path === 'string' && r.path.length > 0,
      20000,
      500,
    )
    expect(cur?.path, 'getCurrentPage should report the active native page path').toContain('pages/')

    const start = cur!
    const target = (start.path ?? '').includes('cart') ? 'pages/home/home' : 'pages/cart/cart'
    const marker = target.split('/')[1] // 'cart' or 'home'

    await callWxMethod(electronApp, 'switchTab', [{ url: '/' + target }])

    const after = await pollUntil(
      () => getCurrentPage(electronApp).catch(() => null),
      (r) => !!r && typeof r.path === 'string' && r.path.includes(marker),
      15000,
      500,
    )
    expect(after?.path, `switchTab should move the active page to ${target}`).toContain(marker)
  })
})
