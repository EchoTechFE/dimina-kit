import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { openProjectInUI, waitForSimulatorWebview, closeProject, ipcInvoke, pollUntil, evalInSimulator, findMainWindow } from './helpers'
import { AutomationChannel } from '../src/shared/ipc-channels'
import { FRONTEND_BOOTSTRAP_PROBE_SCRIPT } from '../src/main/services/views/frontend-bootstrap-gate'

/**
 * Real-Electron extreme-journey coverage for the independent floating
 * internal DevTools window (`internal-devtools-window/index.ts`), owned by the
 * project window it debugs, and its unfiltered console mirror
 * (`global-console-mirror.ts`) — the standalone-app-cdp split.
 * `internal-devtools-window.spec.ts` already covers the single-click
 * open/reuse/hide contract in isolation; this spec drives the SAME window
 * through button-mashing, open/close churn, and project /
 * window lifecycle transitions happening WHILE it stays open, to falsify
 * the class of bug this design is most exposed to: a duplicate BrowserWindow,
 * a lost or duplicated mirrored console entry, or a mirror left wired to a
 * torn-down service host after the project underneath it churns.
 *
 * Tests build on the window state the earlier ones left behind, matching this
 * suite's existing `test.describe.configure({ mode: 'serial' })` convention:
 * one floating instance runs from the first test through the click storm and
 * the open/close churn, and the project close/reopen test then proves the
 * instance is owned by its project window — destroyed with it, rebuilt on the
 * next one, never duplicated.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

let electronApp: ElectronApplication
let mainWindow: PwPage
let workbench: PwPage

type FrontendKind = 'floating' | 'right'

/** Resolve a `devtools://` front-end wc by which BrowserWindow owns it — the
 * floating window's title contains '调试' (see internal-devtools-window/index.ts's
 * `'全局调试'` title); the right-panel front-end is hosted inside the project
 * window itself, whose title is the project's name and never contains '调试'.
 * Never via
 * `devToolsWebContents`/`isDevToolsOpened()` — both read `null` for a
 * `setDevToolsWebContents`-based external front-end regardless of whether it
 * is genuinely attached (see console-filter-live.spec.ts's header comment for
 * the same finding). */
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

/** Execute JS inside a devtools front-end's own realm. */
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

/** Whether `Console.ConsoleView`'s reader surface is safe to call right now —
 * distinct from bootstrap-complete (mirrors console-filter-live.spec.ts's
 * `isConsoleReaderUsable`, so a genuine reader failure and "token not found"
 * are never conflated under one sentinel). */
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

async function getServiceWcId(): Promise<number | null> {
  return electronApp.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().includes('service.html'))
    return wc ? wc.id : null
  })
}

/** Log one line inside the (real, live) service host's own console — the
 * only interception-free source both the right-panel CDP capture and the
 * floating window's unfiltered mirror observe. Awaited (not fire-and-forget):
 * an unawaited `executeJavaScript` against a mid-teardown wc can silently
 * reject, which would be indistinguishable from the mirror itself losing the
 * entry at the assertion site. */
async function logInServiceHost(text: string): Promise<void> {
  const id = await getServiceWcId()
  if (id === null) throw new Error('service host wc not found')
  await electronApp.evaluate(async ({ webContents }, args) => {
    const wc = webContents.fromId(args.id)
    if (!wc || wc.isDestroyed()) throw new Error('service host wc vanished before logging')
    await wc.executeJavaScript(`console.log(${JSON.stringify(args.text)})`)
  }, { id, text })
}

async function windowCount(): Promise<number> {
  return electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
}

/** How many floating debug windows exist right now — the orphan check: a
 * project window that goes away must take its floating window with it, and a
 * reopened project must not stack a second one next to a survivor. */
async function floatingWindowCount(): Promise<number> {
  return electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((x) => x.getTitle().includes('调试')).length)
}

async function floatingVisible(): Promise<boolean | null> {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle().includes('调试'))
    return w ? w.isVisible() : null
  })
}

/** The user-initiated native close — hides rather than destroys (see
 * internal-devtools-window/index.ts's module doc); mirrors
 * internal-devtools-window.spec.ts's own close mechanics. */
async function closeFloatingNatively(): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle().includes('调试'))
    if (!w) throw new Error('floating devtools window not found')
    w.close()
  })
}

async function openFloatingViaButton(): Promise<void> {
  await workbench.getByTestId('sim-open-internal-devtools').click()
}

async function waitForSimulatorSettled(timeoutMs = 45000): Promise<void> {
  await waitForSimulatorWebview(electronApp)
  await pollUntil(
    () => evalInSimulator<boolean>(electronApp, `(() => !!document.querySelector('.device-shell-root'))()`).catch(() => false),
    (ok) => ok === true, timeoutMs, 300,
  )
}

test.describe('Floating internal DevTools window — extreme journeys', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    test.setTimeout(240_000)
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e', 'userdata', `standalone-window-churn-${process.pid}`)
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

    workbench = await openProjectInUI(electronApp, FIXTURE_DIR, { waitMs: 20000 })
    await waitForSimulatorSettled()
  })

  test.afterAll(async () => {
    await closeProject(electronApp).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('a click storm (10 clicks within 200ms) opens exactly one extra BrowserWindow, no residue', async () => {
    const before = await windowCount()

    // Dispatch all 10 clicks synchronously inside one evaluate call — the
    // whole loop runs in well under 200ms, tighter than an actual human could
    // click, and stronger stress than 10 sequential Playwright `.click()`
    // calls (each of which pays its own actionability wait).
    await workbench.evaluate(() => {
      const btn = document.querySelector('[data-testid="sim-open-internal-devtools"]') as HTMLElement | null
      if (!btn) throw new Error('debug button not found in the simulator toolbar')
      for (let i = 0; i < 10; i++) btn.click()
    })

    await pollUntil(() => windowCount(), (n) => n === before + 1, 10000, 200)
    // Give any (incorrect) duplicate-window build a chance to show up before
    // asserting its absence.
    await new Promise((r) => setTimeout(r, 1000))
    expect(await windowCount(), '10 rapid clicks must only ever build ONE extra BrowserWindow').toBe(before + 1)
    expect(await floatingVisible(), 'the floating window must end up visible').toBe(true)

    await pollUntil(() => isFrontendBootstrapped('floating'), (ok) => ok === true, 30000, 300)
    await pollUntil(() => isConsoleReaderUsable('floating'), (ok) => ok === true, 30000, 300)
  })

  test('open→close→open ×8 preserves every round token exactly once, window count never drifts', async () => {
    test.setTimeout(180_000)
    expect(await floatingVisible(), 'precondition: floating window already open from the previous test').toBe(true)
    const baselineCount = await windowCount()

    const tokens: string[] = []
    const rand = `${process.pid}_${Date.now()}`
    for (let round = 0; round < 8; round++) {
      await closeFloatingNatively()
      await pollUntil(() => floatingVisible(), (v) => v === false, 10000, 200)
      expect(await windowCount(), `round ${round}: hiding must not destroy the window`).toBe(baselineCount)

      // Log the round's token WHILE the window is hidden — this is the path
      // that depends on the forwarder's history buffer + the reopen replay
      // (createOpenGatedRelay) rather than the live-injection path a token
      // logged while visible would exercise.
      const token = `CHURN_${rand}_${round}`
      tokens.push(token)
      await logInServiceHost(token)

      await openFloatingViaButton()
      await pollUntil(() => floatingVisible(), (v) => v === true, 10000, 200)
      expect(await windowCount(), `round ${round}: reopen must reuse the SAME window`).toBe(baselineCount)

      await pollUntil(() => isFrontendBootstrapped('floating'), (ok) => ok === true, 20000, 300)
      await pollUntil(() => isConsoleReaderUsable('floating'), (ok) => ok === true, 20000, 300)
    }

    for (const token of tokens) {
      const count = await pollUntil(
        () => countVisibleToken('floating', token).catch(() => -1),
        (n) => n >= 1, 20000, 300,
      )
      expect(count, `round token ${token} must appear in the floating console EXACTLY once (no loss, no dup)`).toBe(1)
    }
  })

  test('the floating window reopened after a project close/reopen mirrors the NEW service host', async () => {
    test.setTimeout(180_000)
    expect(await floatingVisible(), 'precondition: floating window is open from the previous test').toBe(true)

    await closeProject(electronApp)
    // The floating window debugs one project window's renderer and is owned by
    // that window's context, so closing the project destroys it. What must not
    // survive is an orphan still mirroring a service host that is gone.
    await pollUntil(() => floatingWindowCount(), (n) => n === 0, 30000, 300)
    expect(await floatingWindowCount(), 'closing the project must leave no floating window behind').toBe(0)

    workbench = await openProjectInUI(electronApp, FIXTURE_DIR, { waitMs: 20000 })
    await waitForSimulatorSettled()

    await openFloatingViaButton()
    await pollUntil(() => floatingVisible(), (v) => v === true, 15000, 200)
    expect(await floatingWindowCount(), 'the reopened project must own exactly one floating window').toBe(1)
    await pollUntil(() => isFrontendBootstrapped('floating'), (ok) => ok === true, 30000, 300)

    const rand = `${process.pid}_${Date.now()}`
    const token = `REOPEN_${rand}`
    await pollUntil(() => getServiceWcId(), (id) => id !== null, 30000, 300)
    await logInServiceHost(token)

    // Right panel: re-attaches to the new service host (view-manager repoint).
    await pollUntil(() => getDevtoolsFrontendWcId('right'), (id) => id !== null, 45000, 500)
    await pollUntil(() => isFrontendBootstrapped('right'), (ok) => ok === true, 45000, 500)
    const rightCount = await pollUntil(() => countVisibleToken('right', token).catch(() => -1), (n) => n >= 1, 30000, 300)
    expect(rightCount, 'the new session token must reach the right-panel Console').toBeGreaterThanOrEqual(1)

    // Floating window: same forwarder, same mirror, must also observe it.
    await pollUntil(() => isConsoleReaderUsable('floating'), (ok) => ok === true, 20000, 300)
    const floatingCount = await pollUntil(() => countVisibleToken('floating', token).catch(() => -1), (n) => n >= 1, 30000, 300)
    expect(floatingCount, 'the new session token must reach the floating window Console').toBeGreaterThanOrEqual(1)
  })

  test('hiding the workbench window during a log does not drop the entry from the floating console', async () => {
    test.setTimeout(90_000)
    expect(await floatingVisible(), 'precondition: floating window is open from the previous test').toBe(true)

    const workbenchHandle = await electronApp.browserWindow(workbench)
    await workbenchHandle.evaluate((win) => win.hide())

    const rand = `${process.pid}_${Date.now()}`
    const token = `HIDDEN_MAIN_${rand}`
    try {
      await logInServiceHost(token)
    } finally {
      await workbenchHandle.evaluate((win) => win.show())
    }

    const count = await pollUntil(() => countVisibleToken('floating', token).catch(() => -1), (n) => n >= 1, 20000, 300)
    expect(count, 'a log emitted while the main window is hidden must still reach the floating console').toBeGreaterThanOrEqual(1)
  })
})
