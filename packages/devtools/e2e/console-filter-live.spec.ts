import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { openProjectInUI, waitForSimulatorWebview, closeProject, ipcInvoke, pollUntil, evalInSimulator } from './helpers'
import { AutomationChannel } from '../src/shared/ipc-channels'
import { DEFAULT_INTERNAL_LOG_FILTER } from '../src/main/services/views/console-filter'
import { FRONTEND_BOOTSTRAP_PROBE_SCRIPT } from '../src/main/services/views/frontend-bootstrap-gate'

/**
 * Real-Electron regression for the right-panel Console's `[service]` de-noise
 * filter (`console-filter.ts`) — a persisted-preference write alone cannot
 * update an already-constructed Console panel's live filter box (see that
 * module's header comment), so framework-internal `[service]`-prefixed lines
 * could leak straight through to the user-facing panel unfiltered (real
 * repro). `buildLiveConsoleFilterScript` drives the panel's live filter
 * object directly; this spec proves it actually hides those lines end-to-end
 * against the real bundled front-end, not just the generated script string in
 * isolation (already covered by console-filter.test.ts's unit tests).
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

let electronApp: ElectronApplication
let mainWindow: PwPage

/**
 * Resolve the right-panel DevTools front-end wc by its own `devtools://`
 * front-end URL — NOT via `webContents.devToolsWebContents` on the inspected
 * service host. That accessor (and `isDevToolsOpened()`) is backed by
 * Electron's `managed_devtools_web_contents_` internal state, which is never
 * populated for a `setDevToolsWebContents`-based EXTERNAL front-end (exactly
 * what `native-simulator-devtools-host.ts` uses — see
 * `internal-devtools-window.ts`'s header comment for the same finding against
 * `closeDevTools()`). Reading `.devToolsWebContents` reads `null` regardless
 * of whether the front-end is genuinely attached and live, which is why this
 * spec flaked: the front-end's own URL is the reliable signal instead.
 */
async function getServiceDevtoolsFrontendWcId(): Promise<number | null> {
  return electronApp.evaluate(({ webContents }) => {
    const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
    const front = all.find((wc) => wc.getURL().startsWith('devtools://devtools/bundled/devtools_app.html'))
    return front ? front.id : null
  })
}

/** Execute JS in the right-panel front-end's own realm. */
async function evalInDevtoolsFrontend<T>(expr: string): Promise<T> {
  const frontId = await getServiceDevtoolsFrontendWcId()
  if (frontId === null) throw new Error('right-panel devtools front-end is not attached')
  return electronApp.evaluate(async ({ webContents }, args) => {
    const front = webContents.fromId(args.id)
    if (!front || front.isDestroyed()) throw new Error('front-end wc vanished')
    return front.executeJavaScript(args.expr)
  }, { id: frontId, expr }) as Promise<T>
}

/**
 * Whether `Console.ConsoleView`'s reader surface (`itemCount()`/`itemElement()`,
 * not just `instance()`) is actually usable right now. `instance()` succeeding
 * does NOT imply these are safe to call yet (adversarial review, this
 * session) — conflating "reader broken" with "token not found" under one `-1`
 * sentinel made a real flaky failure impossible to diagnose from its trace.
 */
async function isConsoleReaderUsable(): Promise<boolean> {
  const script = `(function(){
    try {
      var view = globalThis.Console.ConsoleView.instance();
      var n = view.itemCount();
      if (n > 0) view.itemElement(0);
      return true;
    } catch(e) { return false; }
  })()`
  return evalInDevtoolsFrontend<boolean>(script).catch(() => false)
}

/** Count how many currently-visible Console rows contain `token`. Callers
 * must confirm `isConsoleReaderUsable()` first — this throws (rather than
 * silently returning a sentinel) if the reader itself is not usable, so a
 * genuine reader failure is never confused with "0 matches found". */
async function countVisibleToken(token: string): Promise<number> {
  const script = `(function(){
    var view = globalThis.Console.ConsoleView.instance();
    var n = view.itemCount();
    var count = 0;
    for (var i = 0; i < n; i++) {
      try {
        var it = view.itemElement(i);
        var combined = String(it.message ? it.message.messageText : '');
        if (combined.indexOf(${JSON.stringify(token)}) !== -1) count++;
      } catch(e) {}
    }
    return count;
  })()`
  return evalInDevtoolsFrontend<number>(script)
}

test.describe('Right-panel Console [service] de-noise filter (live)', () => {
  test.setTimeout(240_000)

  test.beforeAll(async () => {
    test.setTimeout(240_000)
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e', 'userdata', `console-filter-live-${process.pid}`)
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

    // Wait for the right-panel front-end to be attached and its ConsoleView
    // constructible before running assertions. Transient evaluate() failures
    // must not abort the poll (pollUntil treats a rejection as fatal).
    await pollUntil(
      () => getServiceDevtoolsFrontendWcId().catch(() => null),
      (id) => id !== null,
      45000, 500,
    )
    // Bootstrap-complete gate via the SIDE-EFFECT-FREE probe — never by
    // constructing `Console.ConsoleView.instance()` from out here: an early
    // construction transitively creates IssuesManager and permanently kills
    // the front-end's own bootstrap (the exact production bug this spec's
    // flake traced back to; see frontend-bootstrap-gate.ts).
    await pollUntil(
      () => evalInDevtoolsFrontend<boolean>(FRONTEND_BOOTSTRAP_PROBE_SCRIPT).catch(() => false),
      (ok) => ok === true,
      45000, 500,
    )
    // `instance()` succeeding does not imply itemCount()/itemElement() are
    // safe to call yet (adversarial review, this session) — wait for the
    // actual reader surface this spec depends on, not just construction.
    await pollUntil(
      () => isConsoleReaderUsable(),
      (ok) => ok === true,
      45000, 500,
    )
  })

  test.afterAll(async () => {
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('a [service]-prefixed framework log is hidden, an ordinary business log is visible', async () => {
    const rand = `${process.pid}-${Date.now()}`
    const hiddenToken = `hidden-${rand}`
    const visibleToken = `visible-${rand}`

    const service = await electronApp.evaluate(({ webContents }) => {
      const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
      const wc = all.find((w) => w.getURL().includes('service.html'))
      return wc ? wc.id : null
    })
    expect(service, 'service-host window should exist').not.toBeNull()

    // `applyConsoleFilter`'s live-apply runs its OWN bounded poll inside the
    // front-end realm (independent of this spec's own polling for ConsoleView
    // constructibility above) — wait for THAT to have actually landed (the
    // EXACT expected default, not merely "something non-empty" — a stale
    // custom value could otherwise satisfy a laxer check without the fix
    // having actually applied) before logging test tokens, rather than
    // racing it with a fixed sleep.
    await pollUntil(
      () => evalInDevtoolsFrontend<string>(`(function(){
        try { return globalThis.Console.ConsoleView.instance().filter.textFilterUI.value(); }
        catch(e) { return ''; }
      })()`).catch(() => ''),
      (value) => value === DEFAULT_INTERNAL_LOG_FILTER,
      45000, 500,
    )

    // Awaited (not fire-and-forget, adversarial review this session): an
    // unawaited executeJavaScript against a loading/destroyed/repointed
    // service wc can silently reject, and the message this spec depends on
    // would simply never be logged — indistinguishable, at the assertion
    // below, from the filter itself failing to work.
    await electronApp.evaluate(async ({ webContents }, args) => {
      const wc = webContents.fromId(args.id as number)
      if (!wc) throw new Error('service host wc vanished before logging test tokens')
      await wc.executeJavaScript(`console.log('[service] ${args.hiddenToken}')`)
      await wc.executeJavaScript(`console.log('普通业务日志 ${args.visibleToken}')`)
    }, { id: service, hiddenToken, visibleToken })

    // Confirm the reader surface itself is usable BEFORE counting — a reader
    // failure and "0 matches found" must never be conflated (adversarial
    // review this session: the previous single `-1` sentinel made a real
    // flaky failure undiagnosable from its own trace).
    await pollUntil(
      () => isConsoleReaderUsable(),
      (ok) => ok === true,
      45000, 500,
    )

    // The reader-usable gate above already gives failure-mode clarity — a
    // reader that goes unusable AGAIN between here and the gate (rare, but
    // possible under real timing) must still just cost this poll a retry
    // cycle, not abort the whole test (pollUntil treats a rejection as
    // fatal); -1 never satisfies `n >= 1`.
    const visibleCount = await pollUntil(
      () => countVisibleToken(visibleToken).catch(() => -1),
      (n) => n >= 1,
      45000, 500,
    )
    expect(visibleCount, 'the ordinary business log should be visible in the right-panel Console').toBeGreaterThanOrEqual(1)

    // Give the (correctly hidden) message every chance to have shown up if the
    // filter were NOT working, before asserting it never did. A `-1` sentinel
    // here (transient reader hiccup, not "0 matches") must not read as a
    // false pass OR a false fail against `toBe(0)` — retry a few times
    // rather than either swallowing it into `-1` or letting one hiccup abort
    // the whole test on an unrelated transient error.
    await new Promise((r) => setTimeout(r, 1000))
    let hiddenCount = -1
    for (let attempt = 0; attempt < 5 && hiddenCount === -1; attempt++) {
      hiddenCount = await countVisibleToken(hiddenToken).catch(() => -1)
      if (hiddenCount === -1) await new Promise((r) => setTimeout(r, 300))
    }
    expect(hiddenCount, 'the [service]-prefixed framework log should be hidden from the right-panel Console').toBe(0)
  })
})
