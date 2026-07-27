import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { openProjectInUI, waitForSimulatorWebview, closeProject, ipcInvoke, pollUntil, evalInSimulator, DEMO_APP_DIR } from './helpers'
import { AutomationChannel } from '../src/shared/ipc-channels'
import { FRONTEND_BOOTSTRAP_PROBE_SCRIPT } from '../src/main/services/views/frontend-bootstrap-gate'

/**
 * Real-Electron regression: the right-panel Chrome DevTools Console keeps
 * working across a real project switch (close project A, open project B),
 * not merely across a page navigation within the SAME project (already
 * covered by native-host-devtools-console.spec.ts's "after navigateTo"
 * case).
 *
 * `native-simulator-devtools-host.ts`'s `detachSimulator` calls
 * `devtoolsHost.destroyHostView()` on project close, and the next project's
 * `attach()` rebuilds a FRESH, never-navigated front-end host
 * (`rebuildDevtoolsHostView`) and re-points it at the new project's service
 * host via `onNativeServiceHostReady` (the `ServiceHostReadyEvent` listener)
 * or the wall-clock-bounded fallback poll. This spec proves that re-point
 * chain stays alive end-to-end: a log made in project A's service host is
 * visible in the panel, and — after switching to project B — a log made in
 * B's (entirely new) service host is ALSO visible in the (rebuilt) panel.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_B_DIR = path.resolve(__dirname, 'fixtures', 'tabbar-app')

let electronApp: ElectronApplication
let mainWindow: PwPage

/** Resolve the right-panel DevTools front-end wc by its own `devtools://` URL — never re-resolved from a
 * cached id, since a project switch rebuilds an entirely new front-end host. */
async function getServiceDevtoolsFrontendWcId(): Promise<number | null> {
  return electronApp.evaluate(({ webContents }) => {
    const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
    const front = all.find((wc) => wc.getURL().startsWith('devtools://devtools/bundled/devtools_app.html'))
    return front ? front.id : null
  })
}

async function evalInDevtoolsFrontend<T>(expr: string): Promise<T> {
  const frontId = await getServiceDevtoolsFrontendWcId()
  if (frontId === null) throw new Error('right-panel devtools front-end is not attached')
  return electronApp.evaluate(async ({ webContents }, args) => {
    const front = webContents.fromId(args.id)
    if (!front || front.isDestroyed()) throw new Error('front-end wc vanished')
    return front.executeJavaScript(args.expr)
  }, { id: frontId, expr }) as Promise<T>
}

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

/** Best-effort read of the currently-selected DevTools tab's visible text, walking
 * open shadow roots the same way devtools-tabs.ts's own DOM fallback does. Returns
 * null (never throws) when the tab bar can't be reached — callers must treat null
 * as "not reliably observable", not as a failure. */
async function readSelectedTabText(): Promise<string | null> {
  const script = `(function(){
    function deep(sel){
      var out = [], stack = [document];
      while (stack.length) {
        var root = stack.pop();
        try { var m = root.querySelectorAll ? root.querySelectorAll(sel) : []; for (var i=0;i<m.length;i++) out.push(m[i]); } catch(e) {}
        try { var all = root.querySelectorAll ? root.querySelectorAll('*') : []; for (var j=0;j<all.length;j++) { if (all[j].shadowRoot) stack.push(all[j].shadowRoot); } } catch(e) {}
      }
      return out;
    }
    try {
      var tabs = deep('[role="tab"]');
      for (var i=0;i<tabs.length;i++) {
        if (tabs[i].getAttribute('aria-selected') === 'true') return (tabs[i].textContent || '').trim();
      }
      return null;
    } catch(e) { return null; }
  })()`
  return evalInDevtoolsFrontend<string | null>(script).catch(() => null)
}

async function logInServiceHost(token: string): Promise<void> {
  await electronApp.evaluate(async ({ webContents }, tok) => {
    const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
    const wc = all.find((w) => w.getURL().includes('service.html'))
    if (!wc) throw new Error('service-host wc not found')
    await wc.executeJavaScript(`console.log(${JSON.stringify(tok)})`)
  }, token)
}

/** Wait until a (freshly resolved) right-panel front-end is attached, its own
 * bootstrap is complete, and its Console reader is usable — the same 3-gate
 * sequence console-filter-live.spec.ts uses, re-run after every project open
 * since a switch rebuilds an entirely new front-end host. */
async function waitRightPanelConsoleReady(): Promise<void> {
  await pollUntil(
    () => getServiceDevtoolsFrontendWcId().catch(() => null),
    (id) => id !== null,
    45000, 500,
  )
  await pollUntil(
    () => evalInDevtoolsFrontend<boolean>(FRONTEND_BOOTSTRAP_PROBE_SCRIPT).catch(() => false),
    (ok) => ok === true,
    45000, 500,
  )
  await pollUntil(
    () => isConsoleReaderUsable(),
    (ok) => ok === true,
    45000, 500,
  )
}

test.describe('Right-panel Console keeps working after switching projects', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  test.beforeAll(async () => {
    test.setTimeout(240_000)
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(__dirname, '..', 'node_modules', '.cache', 'devtools-e2e', 'userdata', `nh-console-project-switch-${process.pid}`)
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
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('a log in project A is visible, then a log in project B (after a real close+reopen) is visible too', async () => {
    // ── Project A ────────────────────────────────────────────────────────
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 60_000 })
    await waitForSimulatorWebview(electronApp)
    await pollUntil(
      () => evalInSimulator<boolean>(electronApp, `(() => !!document.querySelector('.device-shell-root'))()`).catch(() => false),
      (ok) => ok === true, 45000, 300,
    )
    await waitRightPanelConsoleReady()

    const frontendIdForA = await getServiceDevtoolsFrontendWcId()
    expect(frontendIdForA, 'a right-panel devtools front-end should be attached for project A').not.toBeNull()

    const tokenA = `projA-${process.pid}-${Date.now()}`
    await logInServiceHost(tokenA)

    const countA = await pollUntil(
      () => countVisibleToken(tokenA).catch(() => -1),
      (n) => n >= 1,
      45000, 500,
    )
    expect(countA, 'a log made in project A\'s service host should be visible in the right-panel Console').toBeGreaterThanOrEqual(1)

    // Best-effort: the panel should default to (or already be on) the Console
    // tab. Soft-checked — if the tab bar isn't reliably observable through
    // shadow DOM traversal, skip rather than assert something brittle.
    const selectedTabForA = await readSelectedTabText()
    if (selectedTabForA !== null) {
      expect(['Console', '控制台']).toContain(selectedTabForA)
    } else {
      console.warn('[e2e] selected-tab text not observable for project A — skipping that soft assertion')
    }

    // ── Switch to project B: a REAL close, not just the back-button path ──
    await closeProject(mainWindow)
    await openProjectInUI(mainWindow, PROJECT_B_DIR, { waitMs: 60_000 })
    await waitForSimulatorWebview(electronApp)
    await pollUntil(
      () => evalInSimulator<boolean>(electronApp, `(() => !!document.querySelector('.device-shell-root'))()`).catch(() => false),
      (ok) => ok === true, 45000, 300,
    )
    // Re-resolve everything fresh — closing project A destroys the old
    // front-end host view entirely; project B's attach() rebuilds a new one.
    await waitRightPanelConsoleReady()

    const tokenB = `projB-${process.pid}-${Date.now()}`
    await logInServiceHost(tokenB)

    const countB = await pollUntil(
      () => countVisibleToken(tokenB).catch(() => -1),
      (n) => n >= 1,
      45000, 500,
    )
    expect(countB, 'a log made in project B\'s (new) service host should be visible in the (rebuilt) right-panel Console after switching').toBeGreaterThanOrEqual(1)

    const selectedTabForB = await readSelectedTabText()
    if (selectedTabForB !== null) {
      expect(['Console', '控制台']).toContain(selectedTabForB)
    } else {
      console.warn('[e2e] selected-tab text not observable for project B — skipping that soft assertion')
    }
  })
})
