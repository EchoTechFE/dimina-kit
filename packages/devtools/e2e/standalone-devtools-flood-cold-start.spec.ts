import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { addProject, waitForSimulatorWebview, closeProject, ipcInvoke, pollUntil, evalInSimulator, findMainWindow, findWorkbenchWindow } from './helpers'
import { AutomationChannel } from '../src/shared/ipc-channels'
import { INTERNAL_LOG_WRAPPER_MARK } from '../src/main/services/views/console-filter'
import { FRONTEND_BOOTSTRAP_PROBE_SCRIPT } from '../src/main/services/views/frontend-bootstrap-gate'

/**
 * Real-Electron extreme-journey coverage for two remaining risk areas of the
 * standalone-app-cdp split not covered by
 * `standalone-devtools-window-churn.spec.ts`:
 *
 *  - two independent `devtools://` front-ends (the right panel and the
 *    floating app-wide window) racing to cold-boot at the same time, right
 *    after a project opens;
 *  - a log flood (300 lines, including one pathological 200KB string, one
 *    emoji/unicode line, and one circular-reference object) hitting the
 *    service-host console capture the right panel and the floating mirror
 *    both read from, without wedging either.
 *
 * Kept in its own file (rather than appended to the churn spec) so a cold
 * project boot is genuinely the FIRST thing this file's Electron instance
 * ever does — the churn spec's shared project is already fully settled by
 * the time its own tests run.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

let electronApp: ElectronApplication
let mainWindow: PwPage

type FrontendKind = 'floating' | 'right'

/** Same resolution strategy as standalone-devtools-window-churn.spec.ts: the
 * floating window's own BrowserWindow title contains '调试'
 * ('全局调试' — internal-devtools-window/index.ts); the right-panel front-end
 * lives inside the main window (title 'Dimina DevTools'). */
async function getDevtoolsFrontendWcId(kind: FrontendKind): Promise<number | null> {
  return electronApp.evaluate(({ webContents, BrowserWindow }, k) => {
    const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
    const front = all.find((wc) => {
      if (!wc.getURL().startsWith('devtools://devtools/bundled/devtools_app.html')) return false
      const owner = BrowserWindow.fromWebContents(wc)
      const isFloating = !!owner && owner.getTitle().includes('调试')
      return k === 'floating' ? isFloating : !isFloating
    })
    return front ? front.id : null
  }, kind)
}

async function evalInFrontend<T>(kind: FrontendKind, expr: string): Promise<T> {
  const id = await getDevtoolsFrontendWcId(kind)
  if (id === null) throw new Error(`${kind} devtools front-end is not attached`)
  return electronApp.evaluate(async ({ webContents }, args) => {
    const front = webContents.fromId(args.id)
    if (!front || front.isDestroyed()) throw new Error('front-end wc vanished')
    return front.executeJavaScript(args.expr)
  }, { id, expr }) as Promise<T>
}

async function isFrontendBootstrapped(kind: FrontendKind): Promise<boolean> {
  return evalInFrontend<boolean>(kind, FRONTEND_BOOTSTRAP_PROBE_SCRIPT).catch(() => false)
}

async function isConsoleReaderUsable(kind: FrontendKind): Promise<boolean> {
  const script = `(function(){
    try {
      var view = globalThis.Console.ConsoleView.instance();
      var n = view.itemCount();
      if (n > 0) view.itemElement(0);
      return true;
    } catch(e) { return false; }
  })()`
  return evalInFrontend<boolean>(kind, script).catch(() => false)
}

async function countVisibleToken(kind: FrontendKind, token: string): Promise<number> {
  const script = `(function(){
    var view = globalThis.Console.ConsoleView.instance();
    var n = view.itemCount();
    var count = 0;
    for (var i = 0; i < n; i++) {
      try {
        var it = view.itemElement(i);
        var m = it.message;
        // messageText only carries the FIRST console.log argument; the mirror
        // re-emits guest entries as console.log('[service]', ...args), so the
        // searched token lives in message.parameters — join both.
        var combined = m ? [m.messageText].concat((m.parameters || []).map(function (p) {
          return p && p.value !== undefined ? String(p.value) : (p && p.description ? String(p.description) : '')
        })).join(' ') : '';
        if (combined.indexOf(${JSON.stringify(token)}) !== -1) count++;
      } catch(e) {}
    }
    return count;
  })()`
  return evalInFrontend<number>(kind, script)
}

/** Whether the right panel's internal-log hiding is installed — the mark the
 *  wrapper stamps on the ConsoleFilter prototype. */
async function isInternalLogHidingInstalled(): Promise<boolean> {
  return evalInFrontend<boolean>('right', `(function(){
    try {
      var cf = globalThis.Console.ConsoleView.instance().filter.currentFilter;
      return !!Object.getPrototypeOf(cf)[${JSON.stringify(INTERNAL_LOG_WRAPPER_MARK)}];
    } catch(e) { return false; }
  })()`).catch(() => false)
}

/** The developer-facing filter input, which the de-noise must never write to. */
async function readRightPanelFilterValue(): Promise<string> {
  return evalInFrontend<string>('right', `(function(){
    try { return globalThis.Console.ConsoleView.instance().filter.textFilterUI.value(); }
    catch(e) { return 'READ-FAILED'; }
  })()`).catch(() => 'READ-FAILED')
}

async function getServiceWcId(): Promise<number | null> {
  return electronApp.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().includes('service.html'))
    return wc ? wc.id : null
  })
}

async function execInServiceHost(script: string): Promise<void> {
  const id = await getServiceWcId()
  if (id === null) throw new Error('service host wc not found')
  await electronApp.evaluate(async ({ webContents }, args) => {
    const wc = webContents.fromId(args.id)
    if (!wc || wc.isDestroyed()) throw new Error('service host wc vanished before executing')
    await wc.executeJavaScript(args.script)
  }, { id, script })
}

test.describe('Floating internal DevTools window — cold start + log flood', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e', 'userdata', `standalone-flood-cold-${process.pid}`)
    fs.mkdirSync(userDataDir, { recursive: true })

    electronApp = await _electron.launch({
      args: [appPath, 'auto', '--auto-port', '0', `--user-data-dir=${userDataDir}`],
      env: { ...process.env, NODE_ENV: 'test', DIMINA_E2E_USER_DATA_DIR: userDataDir },
    })

    mainWindow = await findMainWindow(electronApp)
    await mainWindow.waitForLoadState('domcontentloaded')

    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isVisible()) {
        await new Promise<void>((resolve) => { win.once('show', resolve); setTimeout(resolve, 5000) })
      }
      if (win) { win.setPosition(-2000, -2000); win.blur() }
    })

    await pollUntil(
      () => ipcInvoke<number | null>(mainWindow, AutomationChannel.GetPort),
      (val) => typeof val === 'number' && (val as number) > 0,
      10000, 100,
    )
  })

  test.afterAll(async () => {
    await closeProject(electronApp).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('opening the floating window immediately after navigating in (before the right panel settles) lets both front-ends cold-boot without wedging each other', async () => {
    test.setTimeout(90_000)

    // Deliberately the MINIMAL open sequence — no wait for compile-complete
    // or the simulator webview, unlike `openProjectInUI`'s own wait budget.
    // The debug button is "always rendered" (simulator-panel.tsx's own
    // comment) independent of the current page/compile state, so it is
    // available the instant the project view mounts.
    await addProject(mainWindow, FIXTURE_DIR)
    await mainWindow.evaluate(() => {
      const testIpc = (window as unknown as { __testIpc?: { emit: (c: string) => void } }).__testIpc
      testIpc?.emit('window:navigateBack')
    })
    const projectPathLabel = mainWindow.locator(`[title="${FIXTURE_DIR}"]`).first()
    await projectPathLabel.waitFor()
    await projectPathLabel.locator('..').click()

    // The click above opens the project in its OWN workbench window (list
    // window stays put) — the debug button lives in that new window, not here.
    const workbench = await findWorkbenchWindow(electronApp, { projectDir: FIXTURE_DIR, timeoutMs: 15000 })
    const debugButton = workbench.getByTestId('sim-open-internal-devtools')
    await debugButton.waitFor({ timeout: 15000 })
    // Fire immediately — the right panel's own service-host attach (which
    // depends on compile finishing) has certainly not happened yet.
    await debugButton.click()

    // Both front-ends must eventually cold-boot cleanly.
    await pollUntil(() => getDevtoolsFrontendWcId('floating'), (id) => id !== null, 45000, 300)
    await pollUntil(() => isFrontendBootstrapped('floating'), (ok) => ok === true, 45000, 300)
    await pollUntil(() => isConsoleReaderUsable('floating'), (ok) => ok === true, 45000, 300)

    await pollUntil(() => getDevtoolsFrontendWcId('right'), (id) => id !== null, 45000, 500)
    await pollUntil(() => isFrontendBootstrapped('right'), (ok) => ok === true, 45000, 500)
    const hidingInstalled = await pollUntil(
      () => isInternalLogHidingInstalled(),
      (ok) => ok === true,
      45000, 500,
    )
    expect(hidingInstalled, 'right-panel internal-log hiding must still install under a cold-start race').toBe(true)
    expect(
      await readRightPanelFilterValue(),
      'and it must install without writing into the developer\'s filter box',
    ).toBe('')

    // And the underlying compile/simulator must have proceeded to completion
    // rather than getting stuck behind the concurrent front-end boot.
    await waitForSimulatorWebview(electronApp)
    await pollUntil(
      () => evalInSimulator<boolean>(electronApp, `(() => !!document.querySelector('.device-shell-root'))()`).catch(() => false),
      (ok) => ok === true, 45000, 300,
    )
  })

  test('a 300-line log flood (200KB string, unicode, circular-ref object) does not break the console fan-out; a sentinel logged after it is still visible on both panels', async () => {
    test.setTimeout(120_000)

    // Precondition from the previous test: both front-ends are attached and
    // usable already — re-confirm rather than assume, since the flood itself
    // is the risk under test.
    await pollUntil(() => isConsoleReaderUsable('right'), (ok) => ok === true, 20000, 300)
    await pollUntil(() => isConsoleReaderUsable('floating'), (ok) => ok === true, 20000, 300)

    const rand = `${process.pid}_${Date.now()}`
    const floodScript = `(function(){
      for (var i = 0; i < 300; i++) {
        if (i === 100) {
          console.log('LONGSTR_${rand}:' + 'A'.repeat(200000) + ':END');
        } else if (i === 150) {
          console.log('EMOJI_${rand} 😀🎉 日本語 unicode-test');
        } else if (i === 200) {
          var o = {};
          o.self = o;
          console.log(o);
        } else {
          console.log('FLOOD_${rand}_' + i);
        }
      }
    })()`
    await execInServiceHost(floodScript)

    const sentinel = `SENTINEL_${rand}`
    await execInServiceHost(`console.log(${JSON.stringify(sentinel)})`)

    // The app itself must still be alive and responsive after the flood —
    // any of these would throw/timeout on a wedged/crashed renderer.
    const rightCount = await pollUntil(() => countVisibleToken('right', sentinel).catch(() => -1), (n) => n >= 1, 30000, 400)
    expect(rightCount, 'the post-flood sentinel must be visible in the right-panel Console').toBeGreaterThanOrEqual(1)

    const floatingCount = await pollUntil(() => countVisibleToken('floating', sentinel).catch(() => -1), (n) => n >= 1, 30000, 400)
    expect(floatingCount, 'the post-flood sentinel must be visible in the floating window Console').toBeGreaterThanOrEqual(1)
  })
})
