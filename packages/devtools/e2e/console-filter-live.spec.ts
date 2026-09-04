import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { openProjectInUI, waitForSimulatorWebview, closeProject, ipcInvoke, pollUntil, evalInSimulator, findMainWindow } from './helpers'
import { AutomationChannel } from '../src/shared/ipc-channels'
import { INTERNAL_LOG_WRAPPER_MARK, buildInternalLogHideScript } from '../src/main/services/views/console-filter'
import { FRONTEND_BOOTSTRAP_PROBE_SCRIPT } from '../src/main/services/views/frontend-bootstrap-gate'

/**
 * Real-Electron regression for the right-panel Console's `[service]` de-noise
 * (`console-filter.ts`), covering the two halves that only a live front-end
 * can prove — the generated script string in isolation is already covered by
 * console-filter.test.ts:
 *   1. Framework-internal `[service]` lines really are hidden, and ordinary
 *      business logs really are not, against the actual bundled Console panel.
 *   2. The developer's visible text-filter box stays EMPTY while that happens.
 *      An earlier implementation achieved the hiding by typing
 *      `-/^\[service\]/` into that box for them, which reappeared on every
 *      re-point and consumed the one filter slot the panel offers.
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

/** Execute JS in a specific front-end realm, named by its wc id. */
async function evalInWc<T>(id: number, expr: string): Promise<T> {
  return electronApp.evaluate(async ({ webContents }, args) => {
    const front = webContents.fromId(args.id)
    if (!front || front.isDestroyed()) throw new Error('front-end wc vanished')
    return front.executeJavaScript(args.expr)
  }, { id, expr }) as Promise<T>
}

/** Execute JS in whichever realm is the right-panel front-end right now. */
async function evalInDevtoolsFrontend<T>(expr: string): Promise<T> {
  const frontId = await getServiceDevtoolsFrontendWcId()
  if (frontId === null) throw new Error('right-panel devtools front-end is not attached')
  return evalInWc<T>(frontId, expr)
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

/**
 * Count how many currently-visible Console rows contain `token`, alongside how
 * many rows could not be read at all.
 *
 * `readErrors` exists because a row that throws must never be silently counted
 * as "does not contain the token": the hidden-token assertion below expects
 * ZERO matches, so swallowing a read failure on the very row under test would
 * turn a broken filter into a passing test. Callers assert `readErrors === 0`
 * before trusting a zero count. `isConsoleReaderUsable()` only probes row 0 and
 * cannot rule this out on its own.
 */
interface TokenScan { count: number, readErrors: number }

async function countVisibleToken(token: string): Promise<TokenScan> {
  const script = `(function(){
    var view = globalThis.Console.ConsoleView.instance();
    var n = view.itemCount();
    var count = 0;
    var readErrors = 0;
    for (var i = 0; i < n; i++) {
      try {
        var it = view.itemElement(i);
        var m = it.message;
        // messageText carries only the FIRST console.log argument; a token
        // passed as a later argument lives in message.parameters. Reading just
        // messageText would report a multi-argument line as "not present",
        // which for the hidden-token assertions is indistinguishable from the
        // filter working.
        var combined = m ? [m.messageText].concat((m.parameters || []).map(function (p) {
          if (!p) return '';
          if (p.value !== undefined) return String(p.value);
          return p.description ? String(p.description) : '';
        })).join(' ') : '';
        if (combined.indexOf(${JSON.stringify(token)}) !== -1) count++;
      } catch(e) { readErrors++; }
    }
    return { count: count, readErrors: readErrors };
  })()`
  return evalInDevtoolsFrontend<TokenScan>(script)
}

/** The service host the right panel is attached to — where test logs originate. */
async function getServiceHostWcId(): Promise<number> {
  const id = await electronApp.evaluate(({ webContents }) => {
    const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
    const wc = all.find((w) => w.getURL().includes('service.html'))
    return wc ? wc.id : null
  })
  if (id === null) throw new Error('service-host window should exist')
  return id
}

/** Whether the production wrapper is currently installed in the right panel. */
async function isWrapperInstalled(): Promise<boolean> {
  return evalInDevtoolsFrontend<boolean>(`(function(){
    try {
      var cf = globalThis.Console.ConsoleView.instance().filter.currentFilter;
      return !!Object.getPrototypeOf(cf)[${JSON.stringify(INTERNAL_LOG_WRAPPER_MARK)}];
    } catch(e) { return false; }
  })()`).catch(() => false)
}

/**
 * Run `body` against a front-end put back into its pre-install state, then hand
 * the realm back exactly as it was found.
 *
 * Single owner for the whole mutation, because every part of it is a way to
 * wreck the realm for everyone after:
 * - The front-end wc is resolved ONCE and every step — including the undo —
 *   runs against that id. Re-resolving per call could hand the undo a
 *   DIFFERENT realm and stamp the wrapper mark onto one that has no wrapper;
 *   production injection reads that mark as "already installed" and would skip
 *   forever.
 * - The mark and the method are restored from their captured property
 *   descriptors, so the realm cannot end up marked-but-unwrapped (or the
 *   reverse) whatever `body` does.
 * - `revealed` is let through by exact text and everything else still goes to
 *   the real wrapper, so the panel keeps its normal filtering while lifted —
 *   a blanket "everything is visible" would flush the whole boot-time backlog
 *   into the panel and make the counts below race.
 * - Restoration is ASSERTED. A spec that quietly fails to restore leaves every
 *   later assertion in this file reading a realm nobody described.
 */
async function withWrapperLifted(revealed: string, body: () => Promise<void>): Promise<void> {
  const frontId = await getServiceDevtoolsFrontendWcId()
  if (frontId === null) throw new Error('right-panel devtools front-end is not attached')

  const markJson = JSON.stringify(INTERNAL_LOG_WRAPPER_MARK)
  const stashJson = JSON.stringify(`__diminaLiftedWrapper_${process.pid}`)
  const revealedJson = JSON.stringify(revealed)

  const lifted = await evalInWc<boolean>(frontId, `(function(){
    var view = globalThis.Console.ConsoleView.instance();
    var proto = Object.getPrototypeOf(view.filter.currentFilter);
    var wrapper = proto.shouldBeVisible;
    globalThis[${stashJson}] = {
      proto: proto,
      method: Object.getOwnPropertyDescriptor(proto, 'shouldBeVisible'),
      mark: Object.getOwnPropertyDescriptor(proto, ${markJson}),
    };
    proto.shouldBeVisible = function(viewMessage) {
      try {
        var text = String(viewMessage.consoleMessage().messageText || '');
        if (text === ${revealedJson}) return true;
      } catch(e) {}
      return wrapper.apply(this, arguments);
    };
    delete proto[${markJson}];
    view.onFilterChanged();
    return true;
  })()`)
  expect(lifted, 'the realm must be back in a pre-install state').toBe(true)

  try {
    await body()
  } finally {
    const restored = await evalInWc<string>(frontId, `(function(){
      var saved = globalThis[${stashJson}];
      if (!saved) return 'nothing-was-saved';
      try {
        if (saved.method) Object.defineProperty(saved.proto, 'shouldBeVisible', saved.method);
        if (saved.mark) Object.defineProperty(saved.proto, ${markJson}, saved.mark);
        else delete saved.proto[${markJson}];
        delete globalThis[${stashJson}];
        globalThis.Console.ConsoleView.instance().onFilterChanged();
        return 'ok';
      } catch(e) { return 'failed: ' + (e && e.message); }
    })()`)
    expect(restored, 'the front-end realm must be handed back exactly as it was found').toBe('ok')
  }
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

    // No workbench Page is kept: every project-scoped assertion below reaches
    // the right-panel front-end / service host through electronApp.evaluate
    // by webContents URL, never through a Playwright Page.
    await openProjectInUI(electronApp, FIXTURE_DIR, { waitMs: 20000 })
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
    await closeProject(electronApp).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('a [service]-prefixed framework log is hidden, an ordinary business log is visible', async () => {
    const rand = `${process.pid}-${Date.now()}`
    const hiddenToken = `hidden-${rand}`
    const hiddenMultiArgToken = `hidden-multiarg-${rand}`
    const visibleToken = `visible-${rand}`
    const visibleMultiArgToken = `visible-multiarg-${rand}`

    const service = await getServiceHostWcId()

    // `applyConsoleFilter`'s injection runs its OWN bounded poll inside the
    // front-end realm (independent of this spec's own polling for ConsoleView
    // constructibility above) — wait for THAT to have actually landed before
    // logging test tokens, rather than racing it with a fixed sleep. The
    // wrapper stamps its mark on the ConsoleFilter prototype, which is the
    // only positive signal available now that nothing is written into the
    // visible filter box.
    await pollUntil(() => isWrapperInstalled(), (installed) => installed === true, 45000, 500)

    // Awaited (not fire-and-forget, adversarial review this session): an
    // unawaited executeJavaScript against a loading/destroyed/repointed
    // service wc can silently reject, and the message this spec depends on
    // would simply never be logged — indistinguishable, at the assertion
    // below, from the filter itself failing to work.
    //
    // The multi-argument pair matters on its own: the framework logs
    // `console.log('[service]', …)`, whose `messageText` is just the tag with
    // the rest in `parameters`. Only a real front-end can settle what that
    // shape actually is, so both the hiding and the row scan are exercised
    // against it here rather than against a hand-written stub.
    await electronApp.evaluate(async ({ webContents }, args) => {
      const wc = webContents.fromId(args.id as number)
      if (!wc) throw new Error('service host wc vanished before logging test tokens')
      await wc.executeJavaScript(`console.log('[service] ${args.hiddenToken}')`)
      await wc.executeJavaScript(`console.log('[service]', '${args.hiddenMultiArgToken}')`)
      await wc.executeJavaScript(`console.log('普通业务日志 ${args.visibleToken}')`)
      await wc.executeJavaScript(`console.log('普通业务日志', '${args.visibleMultiArgToken}')`)
    }, { id: service, hiddenToken, hiddenMultiArgToken, visibleToken, visibleMultiArgToken })

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
    // fatal); the -1 sentinel never satisfies `n >= 1`.
    const visibleCount = await pollUntil(
      () => countVisibleToken(visibleToken).then((s) => s.count).catch(() => -1),
      (n) => n >= 1,
      45000, 500,
    )
    expect(visibleCount, 'the ordinary business log should be visible in the right-panel Console').toBeGreaterThanOrEqual(1)

    // Positive control for the row scan itself: a token that lives in a LATER
    // console.log argument must be findable, otherwise the zero counts below
    // would prove nothing about multi-argument lines.
    const visibleMultiArgCount = await pollUntil(
      () => countVisibleToken(visibleMultiArgToken).then((s) => s.count).catch(() => -1),
      (n) => n >= 1,
      45000, 500,
    )
    expect(visibleMultiArgCount, 'a business log whose token is a later argument must be visible AND findable by the scan').toBeGreaterThanOrEqual(1)

    // Give the (correctly hidden) messages every chance to have shown up if the
    // filter were NOT working, before asserting they never did. A transient
    // reader hiccup must not read as a false pass OR a false fail against
    // `toBe(0)` — retry, keep the last real error, and let it surface if every
    // attempt fails rather than collapsing it into a sentinel.
    await new Promise((r) => setTimeout(r, 1000))
    for (const [token, what] of [
      [hiddenToken, 'a [service]-prefixed framework log'],
      [hiddenMultiArgToken, 'a framework log that passes [service] as its own argument'],
    ] as const) {
      let hiddenScan: TokenScan | null = null
      let lastError: unknown = null
      for (let attempt = 0; attempt < 5 && hiddenScan === null; attempt++) {
        try {
          hiddenScan = await countVisibleToken(token)
        } catch (err) {
          lastError = err
          await new Promise((r) => setTimeout(r, 300))
        }
      }
      if (hiddenScan === null) throw new Error(`could not read the Console rows at all: ${String(lastError)}`)
      // A row that failed to read is NOT evidence of absence — assert the scan
      // was complete before trusting its zero.
      expect(hiddenScan.readErrors, 'every Console row must be readable for a zero count to mean anything').toBe(0)
      expect(hiddenScan.count, `${what} should be hidden from the right-panel Console`).toBe(0)
    }

    // The de-noise must not have cost the developer their filter input.
    const filterBoxValue = await evalInDevtoolsFrontend<string>(`(function(){
      try { return globalThis.Console.ConsoleView.instance().filter.textFilterUI.value(); }
      catch(e) { return 'READ-FAILED'; }
    })()`)
    expect(filterBoxValue, 'the visible Console filter box must stay empty — hiding happens behind it').toBe('')
  })

  /**
   * The test above logs its tokens AFTER the wrapper is installed, so it only
   * proves future messages are judged. The wrapper also calls
   * `view.onFilterChanged()` so lines ALREADY on screen when it lands are
   * re-judged — without that, opening a project would leave every framework
   * line printed during boot sitting in the panel forever. That half needs a
   * message that exists BEFORE the wrapper does, which this test manufactures
   * by putting the realm back into a pre-install state and re-running the very
   * same production script.
   */
  test('a [service] line already on screen disappears when the wrapper lands', async () => {
    const rand = `${process.pid}-${Date.now()}`
    const token = `already-shown-${rand}`
    const line = `[service] ${token}`

    const service = await getServiceHostWcId()
    // Stated here rather than inherited from the test above: lifting a wrapper
    // that was never installed would save the untouched Chromium method and
    // then hand back a realm marked as wrapped but carrying no wrapper —
    // production reads that mark as "already installed" and skips forever.
    await pollUntil(() => isWrapperInstalled(), (installed) => installed === true, 45000, 500)

    await withWrapperLifted(line, async () => {
      await electronApp.evaluate(async ({ webContents }, args) => {
        const wc = webContents.fromId(args.id as number)
        if (!wc) throw new Error('service host wc vanished before logging the token')
        await wc.executeJavaScript(`console.log(${JSON.stringify(args.line)})`)
      }, { id: service, line })

      // Precondition: with the wrapper lifted the line really is on screen.
      const beforeCount = await pollUntil(
        () => countVisibleToken(token).then((s) => s.count).catch(() => -1),
        (n) => n >= 1,
        45000, 500,
      )
      expect(beforeCount, 'with the wrapper lifted the [service] line must be visible — otherwise this test proves nothing').toBeGreaterThanOrEqual(1)

      // Now land the real production script on a panel that is already
      // displaying that line.
      await evalInDevtoolsFrontend<unknown>(buildInternalLogHideScript())

      // No `.catch` sentinel here: pollUntil swallows intermediate errors and
      // lets the final attempt throw, so a reader that is genuinely broken
      // surfaces as its own error instead of masquerading as "0 matches".
      const afterScan = await pollUntil(
        () => countVisibleToken(token),
        (scan) => scan.readErrors === 0 && scan.count === 0,
        20000, 500,
      )
      expect(afterScan, 'the already-displayed [service] line must be re-judged and disappear').toEqual({ count: 0, readErrors: 0 })
    })

    // The realm is back under the production wrapper, not the lifted one.
    expect(await isWrapperInstalled(), 'the production wrapper must be back in place').toBe(true)
  })
})
