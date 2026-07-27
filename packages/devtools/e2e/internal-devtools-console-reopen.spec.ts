import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { openProjectInUI, waitForSimulatorWebview, closeProject, ipcInvoke, pollUntil, evalInSimulator } from './helpers'
import { AutomationChannel } from '../src/shared/ipc-channels'
import { FRONTEND_BOOTSTRAP_PROBE_SCRIPT } from '../src/main/services/views/frontend-bootstrap-gate'

/**
 * Real-Electron regression for the standalone "debug the whole app" window's
 * Console panel across a close (hide) → reopen cycle.
 *
 * The window is built once and hidden (never destroyed) on user close
 * (`internal-devtools-window/index.ts`), and `global-console-mirror.ts` gates
 * its subscription to the buffered `ConsoleForwarder` on that window's
 * visibility, re-subscribing with `{replay:true}` on every reopen so history
 * is never lost. `open-gated-relay.ts`'s header comment documents a
 * previously-confirmed real-machine bug this dedup fixes: naively replaying
 * on every reopen double-injects every entry already shown once, because
 * Chromium's own per-frame console storage on the (never-rebuilt) inspected
 * target is not cleared by hiding the window. This spec proves, against the
 * real bundled front-end, that a reopen shows history once (data survives)
 * and never twice (no duplicate replay) — not just the dedup primitive in
 * isolation (already covered by open-gated-relay.test.ts's unit tests).
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

let electronApp: ElectronApplication
let mainWindow: PwPage

/**
 * Resolve the STANDALONE debug window's own DevTools front-end wc. Opening
 * this window creates a SECOND `devtools://` front-end alongside the
 * always-on right-panel one (native-host attaches that automatically once a
 * project is open) — the only reliable way to tell them apart is the owning
 * `BrowserWindow`'s title: `internal-devtools-window/index.ts`'s `buildOnce`
 * titles its host window `'全局调试'`, which contains `'调试'`; the right
 * panel's front-end host is a `WebContentsView` embedded in the MAIN window,
 * whose title never contains that string.
 */
async function getInternalDevtoolsFrontendWcId(): Promise<number | null> {
  return electronApp.evaluate(({ webContents, BrowserWindow }) => {
    const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
    const front = all.find((wc) => {
      if (!wc.getURL().startsWith('devtools://devtools/bundled/devtools_app.html')) return false
      const owner = BrowserWindow.fromWebContents(wc)
      return !!owner && owner.getTitle().includes('调试')
    })
    return front ? front.id : null
  })
}

/** Execute JS in the standalone debug window's front-end realm. */
async function evalInInternalDevtoolsFrontend<T>(expr: string): Promise<T> {
  const frontId = await getInternalDevtoolsFrontendWcId()
  if (frontId === null) throw new Error('internal debug window front-end is not attached')
  return electronApp.evaluate(async ({ webContents }, args) => {
    const front = webContents.fromId(args.id)
    if (!front || front.isDestroyed()) throw new Error('front-end wc vanished')
    return front.executeJavaScript(args.expr)
  }, { id: frontId, expr }) as Promise<T>
}

/** Same reader-usability gate as console-filter-live.spec.ts: `instance()`
 * succeeding does not imply `itemCount()`/`itemElement()` are safe to call
 * yet — never conflate "reader broken" with "token not found". */
async function isConsoleReaderUsable(): Promise<boolean> {
  const script = `(function(){
    try {
      var view = globalThis.Console.ConsoleView.instance();
      var n = view.itemCount();
      if (n > 0) view.itemElement(0);
      return true;
    } catch(e) { return false; }
  })()`
  return evalInInternalDevtoolsFrontend<boolean>(script).catch(() => false)
}

/** Count how many currently-visible Console rows contain `token`. */
async function countVisibleToken(token: string): Promise<number> {
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
  return evalInInternalDevtoolsFrontend<number>(script)
}

/** Log a token into the service-host realm (the logic layer the mirror mirrors from). */
async function logInServiceHost(token: string): Promise<void> {
  await electronApp.evaluate(async ({ webContents }, tok) => {
    const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
    const wc = all.find((w) => w.getURL().includes('service.html'))
    if (!wc) throw new Error('service-host wc not found')
    await wc.executeJavaScript(`console.log(${JSON.stringify(tok)})`)
  }, token)
}

/** Whether the standalone debug window (matched by title) is currently visible. Null if it doesn't exist yet. */
async function isInternalDevtoolsWindowVisible(): Promise<boolean | null> {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('调试'))
    return win ? win.isVisible() : null
  })
}

/** Native-close the standalone debug window (production intercepts this as hide, not destroy). */
async function closeInternalDevtoolsWindow(): Promise<boolean> {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('调试'))
    if (!win) return false
    win.close()
    return true
  })
}

/** Wait until the standalone debug window's front-end is attached, bootstrapped, and its Console reader is usable. */
async function waitInternalDevtoolsConsoleReady(): Promise<void> {
  await pollUntil(
    () => getInternalDevtoolsFrontendWcId().catch(() => null),
    (id) => id !== null,
    45000, 500,
  )
  await pollUntil(
    () => evalInInternalDevtoolsFrontend<boolean>(FRONTEND_BOOTSTRAP_PROBE_SCRIPT).catch(() => false),
    (ok) => ok === true,
    45000, 500,
  )
  await pollUntil(
    () => isConsoleReaderUsable(),
    (ok) => ok === true,
    45000, 500,
  )
}

test.describe('Standalone debug window Console survives a close/reopen cycle', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  const tokenT1 = `t1-${process.pid}-${Date.now()}`
  const tokenT2 = `t2-${process.pid}-${Date.now()}`

  test.beforeAll(async () => {
    test.setTimeout(240_000)
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e', 'userdata', `internal-devtools-console-reopen-${process.pid}`)
    fs.mkdirSync(userDataDir, { recursive: true })

    electronApp = await _electron.launch({
      args: [appPath, 'auto', '--auto-port', '0', `--user-data-dir=${userDataDir}`],
      env: { ...process.env, NODE_ENV: 'test', DIMINA_E2E_USER_DATA_DIR: userDataDir },
    })

    mainWindow = await electronApp.firstWindow()
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

    await openProjectInUI(mainWindow, FIXTURE_DIR, { waitMs: 20000 })
    await waitForSimulatorWebview(electronApp)
    await pollUntil(
      () => evalInSimulator<boolean>(electronApp, `(() => !!document.querySelector('.device-shell-root'))()`).catch(() => false),
      (ok) => ok === true, 45000, 300,
    )
  })

  test.afterAll(async () => {
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('a log made before the window ever opened is replayed once it opens (history survives)', async () => {
    // Log T1 BEFORE the standalone debug window has ever been opened — it can
    // only reach the panel via the mirror's buffered replay, not live mirroring.
    await logInServiceHost(tokenT1)

    await mainWindow.getByTestId('sim-open-internal-devtools').click()
    await waitInternalDevtoolsConsoleReady()

    const count = await pollUntil(
      () => countVisibleToken(tokenT1).catch(() => -1),
      (n) => n >= 1,
      45000, 500,
    )
    expect(count, 'a log made before the debug window opened should be replayed into its Console panel').toBeGreaterThanOrEqual(1)
  })

  test('closing (hiding) then reopening shows the old and new entries exactly once each — no duplicate replay', async () => {
    const closed = await closeInternalDevtoolsWindow()
    expect(closed, 'the standalone debug window should exist to close').toBe(true)

    await pollUntil(
      () => isInternalDevtoolsWindowVisible(),
      (visible) => visible === false,
      10000, 300,
    )

    // Log T2 while the window is hidden — the mirror's subscription is
    // disposed while hidden, so T2 can only reach the panel via the
    // replay-on-reopen path, exactly like T1 did on first open.
    await logInServiceHost(tokenT2)

    await mainWindow.getByTestId('sim-open-internal-devtools').click()
    await pollUntil(
      () => isInternalDevtoolsWindowVisible(),
      (visible) => visible === true,
      10000, 300,
    )
    // The front-end wc is never rebuilt across hide/show (module doc), but
    // re-confirm the reader is usable before counting.
    await pollUntil(
      () => isConsoleReaderUsable(),
      (ok) => ok === true,
      45000, 500,
    )

    // Give T2's replay-triggered injection every chance to land.
    await pollUntil(
      () => countVisibleToken(tokenT2).catch(() => -1),
      (n) => n >= 1,
      45000, 500,
    )
    // Give a further beat for any (incorrect) duplicate re-injection of T1 to
    // show up before asserting the exact, load-bearing count.
    await new Promise((r) => setTimeout(r, 1500))

    const t1Count = await countVisibleToken(tokenT1)
    const t2Count = await countVisibleToken(tokenT2)

    expect(t1Count, 'the entry logged before the first open must appear exactly once after a reopen (no duplicate replay)').toBe(1)
    expect(t2Count, 'the entry logged while the window was hidden must appear exactly once after reopening').toBe(1)
  })
})
