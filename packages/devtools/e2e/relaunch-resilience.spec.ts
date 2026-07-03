/**
 * Relaunch & compile resilience tests.
 * Tests extreme edge cases: page switching, rapid changes, build errors,
 * file deletion, recovery, and race conditions.
 *
 * NATIVE-HOST migration: the simulator now runs the native-host path by default
 * (the env gate is default-ON). The mini-app page DOM is NO LONGER a
 * same-document iframe; instead:
 *   - The simulator is a top-level "DeviceShell" WebContentsView loading
 *     `simulator.html` (matched by `evalInSimulator`). It mounts
 *     `.device-shell-root` and one `.device-shell__webview` per in-app page.
 *   - Each PAGE is a nested cross-process render-host `<webview>` guest loading
 *     `pageFrame.html?…&pagePath=pages%2F…`.
 *
 * So the old "view is alive" readiness probes (`win.contentView.children >= 2`
 * counted renderer `<webview>`s; `getType()==='webview'` found the single
 * dimina-fe iframe host) no longer describe a live native simulator. We replace
 * them with the DISCRIMINATING native signals used by the native-host-*.spec.ts
 * references: DeviceShell mounted (`.device-shell-root`) with at least one
 * render-host page webview (`.device-shell__webview`), and — for crash/url
 * checks — reading the render-host guests (`pageFrame.html`) directly in main.
 */
import fs from 'fs'
import path from 'path'
import { test, expect } from './fixtures'
import {
  DEMO_APP_DIR,
  openProjectInUI,
  closeProject,
  pollUntil,
  evalInSimulator,
} from './helpers'

// ── Helpers ──────────────────────────────────────────────────────────────

async function getStatus(mainWindow: import('@playwright/test').Page) {
  return mainWindow.evaluate(
    () => document.querySelector('[class*="truncate"]')?.textContent || '',
  )
}

/**
 * Native readiness probe: is the DeviceShell mounted AND carrying at least one
 * render-host page webview?
 *
 * `.device-shell-root` mounts only after `SimulatorMiniApp.spawn()` resolves,
 * and `.device-shell__webview` is exclusive to the native render path (the old
 * dimina-fe container never emitted it). Counting the page webviews replaces the
 * old `contentView.children >= 2` heuristic with a signal that actually proves a
 * live, rendering native simulator. Read in the simulator WCV (which always
 * loads `simulator.html`, so it survives a relaunch reload). Returns 0 on any
 * failure so callers can poll.
 */
async function getDeviceShellWebviewCount(
  electronApp: import('@playwright/test').ElectronApplication,
): Promise<number> {
  return evalInSimulator<number>(
    electronApp,
    `(() => {
      if (!document.querySelector('.device-shell-root')) return 0
      return document.querySelectorAll('.device-shell__webview').length
    })()`,
  ).catch(() => 0)
}

/**
 * Poll until the native simulator is ready again after a (re)launch: the
 * DeviceShell is mounted and at least one render-host page webview exists.
 */
async function waitForDeviceShellReady(
  electronApp: import('@playwright/test').ElectronApplication,
  timeout = 25000,
): Promise<number> {
  return pollUntil(
    () => getDeviceShellWebviewCount(electronApp),
    (n) => n >= 1,
    timeout,
    300,
  )
}

/** Decode a render-host guest's page path out of its `…?pagePath=pages%2F…` URL. */
function guestPagePath(url: string): string {
  const m = url.match(/[?&]pagePath=([^&]+)/)
  if (!m) return ''
  try { return decodeURIComponent(m[1]) } catch { return m[1] }
}

/**
 * Inspect the native render-host page guests (`pageFrame.html`) directly in the
 * main process. Returns each guest's decoded `pagePath` + crash state, plus
 * whether the simulator shell WCV (`simulator.html`) itself is crashed.
 *
 * Replaces the old `getWebviewInfo` which matched the single `getType()==='webview'`
 * dimina-fe iframe host — under native-host there can be several render-host
 * webviews and the simulator shell is a WebContentsView (type `'window'`), so we
 * key off the URLs instead.
 */
async function getNativePageInfo(electronApp: import('@playwright/test').ElectronApplication) {
  return electronApp.evaluate(({ webContents }) => {
    const all = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed())
    const shell = all.find((wc) => wc.getURL().includes('simulator.html'))
    const guests = all.filter((wc) => wc.getURL().includes('pageFrame.html'))
    return {
      shellFound: !!shell,
      shellCrashed: shell ? shell.isCrashed() : false,
      guests: guests.map((wc) => ({ url: wc.getURL(), crashed: wc.isCrashed() })),
    }
  })
}

/**
 * The set of render-host page paths currently rendered + whether ANY guest (or
 * the shell) is crashed. `pagePaths` are decoded route strings like
 * `pages/storage-test/storage-test`.
 */
async function getNativePageState(
  electronApp: import('@playwright/test').ElectronApplication,
): Promise<{ shellFound: boolean; anyCrashed: boolean; pagePaths: string[] }> {
  const info = await getNativePageInfo(electronApp)
  return {
    shellFound: info.shellFound,
    anyCrashed: info.shellCrashed || info.guests.some((g) => g.crashed),
    pagePaths: info.guests.map((g) => guestPagePath(g.url)),
  }
}

async function waitForStatus(
  mainWindow: import('@playwright/test').Page,
  targets: string[],
  timeout = 15000,
) {
  return pollUntil(
    () => getStatus(mainWindow),
    (s) => targets.some((t) => s.includes(t)),
    timeout,
    500,
  )
}

async function clickRelaunchButton(mainWindow: import('@playwright/test').Page) {
  await mainWindow.locator('button[title="重新编译"]').click()
}

async function relaunchViaPopover(
  mainWindow: import('@playwright/test').Page,
  electronApp: import('@playwright/test').ElectronApplication,
  targetPage: string,
) {
  await mainWindow.getByRole('button', { name: /普通编译/ }).click()
  // The popover WCV is created asynchronously after the click; poll for it
  // instead of a fixed sleep (a slow tick leaves the one-shot lookup empty).
  const popoverWcId = await pollUntil(
    () => electronApp.evaluate(({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('entries/popover'))
      // Report the popover only once it can execute JS (loaded) — injecting
      // into a loading wc queues a did-stop-loading waiter instead.
      return wc && !wc.isLoading() ? wc.id : 0
    }),
    (id) => id > 0,
    8000,
    200,
  )
  if (!popoverWcId) throw new Error('Popover not found')

  await electronApp.evaluate(
    async ({ webContents }, { wcId, pg }) => {
      const wc = webContents.fromId(wcId)
      if (!wc) return
      await wc.executeJavaScript(`(function() {
        var sel = document.querySelector('select');
        var opt = Array.from(sel.options).find(function(o) { return o.value.includes('${pg}'); });
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      })()`)
    },
    { wcId: popoverWcId, pg: targetPage },
  )
  await mainWindow.waitForTimeout(200)

  await electronApp.evaluate(async ({ webContents }, wcId) => {
    const wc = webContents.fromId(wcId)
    if (!wc) return
    await wc.executeJavaScript(`(function() {
      var btns = document.querySelectorAll('button');
      for (var b of btns) { if (b.textContent.includes('重新编译')) { b.click(); break; } }
    })()`)
  }, popoverWcId)
}

// ── Tests ────────────────────────────────────────────────────────────────

test.describe('Relaunch & compile resilience', () => {
  test.setTimeout(120_000)

  test.beforeEach(async ({ mainWindow }) => {
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 10000 })
  })

  test.afterEach(async ({ mainWindow }) => {
    await closeProject(mainWindow)
  })

  test('↺ button reloads same page successfully', async ({ mainWindow, electronApp }) => {
    await clickRelaunchButton(mainWindow)
    const status = await waitForStatus(mainWindow, ['刷新完成', '编译完成'])
    expect(status).toContain('完成')

    // After the reload the DeviceShell must remount with a live render-host page
    // webview (the native equivalent of "the simulator views are still alive").
    const webviews = await waitForDeviceShellReady(electronApp)
    expect(
      webviews,
      'DeviceShell should remount with ≥1 render-host page webview after ↺ reload',
    ).toBeGreaterThanOrEqual(1)
  })

  test('popover page switch navigates correctly', async ({ mainWindow, electronApp }) => {
    await relaunchViaPopover(mainWindow, electronApp, 'storage-test')
    const status = await waitForStatus(mainWindow, ['刷新完成', '编译完成'])
    expect(status).toContain('完成')

    // A respawn at storage-test must produce a render-host page guest whose
    // entry route is that page. Poll: the render guest joins shortly after the
    // status flips to 完成.
    const state = await pollUntil(
      () => getNativePageState(electronApp),
      (s) => s.shellFound && s.pagePaths.some((p) => p.includes('storage-test')),
      25000,
      400,
    )
    expect(
      state.pagePaths.some((p) => p.includes('storage-test')),
      `a render-host page guest should be on storage-test; guests=${JSON.stringify(state.pagePaths)}`,
    ).toBe(true)
    expect(state.anyCrashed, 'no render-host guest or shell should be crashed').toBe(false)

    expect(await getDeviceShellWebviewCount(electronApp)).toBeGreaterThanOrEqual(1)
  })

  test('multiple sequential page switches all succeed', async ({ mainWindow, electronApp }) => {
    for (const page of ['console-test', 'storage-test', 'index']) {
      await relaunchViaPopover(mainWindow, electronApp, page)
      const status = await waitForStatus(mainWindow, ['刷新完成', '编译完成'])
      expect(status).toContain('完成')

      // Each respawn must land a render-host page guest on the chosen entry page.
      // The guest URL carries the full route (e.g. pages/console-test/console-test),
      // so matching the page name is unambiguous across switches.
      const state = await pollUntil(
        () => getNativePageState(electronApp),
        (s) => s.shellFound && s.pagePaths.some((p) => p.includes(page)),
        25000,
        400,
      )
      expect(
        state.pagePaths.some((p) => p.includes(page)),
        `after switching to ${page}, a render-host guest should be on it; guests=${JSON.stringify(state.pagePaths)}`,
      ).toBe(true)
      expect(state.anyCrashed, `no guest should crash after switching to ${page}`).toBe(false)
    }
  })

  test('rapid double-click ↺ does not break state', async ({ mainWindow, electronApp }) => {
    await clickRelaunchButton(mainWindow)
    await mainWindow.waitForTimeout(50)
    await clickRelaunchButton(mainWindow)

    const status = await waitForStatus(mainWindow, ['完成', '失败', '超时'])
    expect(status).toContain('完成')

    // A double-fire must still leave the DeviceShell mounted with a live page
    // webview (no half-torn-down state).
    const webviews = await waitForDeviceShellReady(electronApp)
    expect(
      webviews,
      'DeviceShell should remain mounted with ≥1 render-host page webview after a double ↺',
    ).toBeGreaterThanOrEqual(1)
    const state = await getNativePageState(electronApp)
    expect(state.anyCrashed, 'no guest or shell should be crashed after a double ↺').toBe(false)
  })

  test('rapid file changes do not crash webview', async ({ mainWindow, electronApp }) => {
    const files = ['index.js', 'index.wxml', 'index.wxss'].map((f) =>
      path.join(DEMO_APP_DIR, 'pages', 'index', f),
    )
    const originals = Object.fromEntries(
      files.filter((f) => fs.existsSync(f)).map((f) => [f, fs.readFileSync(f, 'utf8')]),
    )

    // The demo-app sources are mutated below; restore them in `finally` so a
    // failing assertion (or a poll timeout throwing mid-test) can never leave
    // sentinel comments polluting the working tree.
    try {
      // Rapid-fire touch 3 files in 300ms
      for (const f of Object.keys(originals)) {
        fs.writeFileSync(f, originals[f] + `\n// e2e-${Date.now()}`)
        await mainWindow.waitForTimeout(100)
      }

      // Wait for rebuild to settle
      await mainWindow.waitForTimeout(15000)

      // The render-host guests must survive the rapid-fire rebuild churn: the
      // DeviceShell still has a live page webview and nothing crashed.
      const webviews = await waitForDeviceShellReady(electronApp)
      expect(
        webviews,
        'DeviceShell should keep ≥1 render-host page webview through rapid file changes',
      ).toBeGreaterThanOrEqual(1)
      const state = await getNativePageState(electronApp)
      expect(state.shellFound, 'simulator shell should still be present').toBe(true)
      expect(state.anyCrashed, 'no render-host guest or shell should crash on rapid file changes').toBe(false)
    } finally {
      // Restore
      for (const [f, content] of Object.entries(originals)) fs.writeFileSync(f, content)
    }
  })

  test('UI stays usable after build error and recovers', async ({ mainWindow, electronApp }) => {
    const jsFile = path.join(DEMO_APP_DIR, 'pages', 'index', 'index.js')
    const original = fs.readFileSync(jsFile, 'utf8')

    // The broken source is restored mid-test as part of the recovery scenario,
    // but if any assertion before that point throws (e.g. the toolbar check),
    // the restore would be skipped and the demo app left broken on disk. The
    // `finally` re-write is idempotent on the happy path and the safety net on
    // every failure path.
    try {
      // Introduce syntax error
      fs.writeFileSync(jsFile, 'const x = {{{BROKEN')
      await mainWindow.waitForTimeout(15000)

      // Toolbar must remain visible (not white/black screen)
      const hasToolbar = await mainWindow.evaluate(() =>
        document.body.innerText.includes('普通编译'),
      )
      expect(hasToolbar).toBe(true)

      // Restore and verify recovery
      fs.writeFileSync(jsFile, original)
      await mainWindow.waitForTimeout(15000)

      // Should be able to relaunch after recovery: the DeviceShell remounts with a
      // live render-host page webview once the good build compiles.
      await clickRelaunchButton(mainWindow)
      await waitForStatus(mainWindow, ['完成', '失败', '超时'])
      const webviews = await waitForDeviceShellReady(electronApp)
      expect(
        webviews,
        'DeviceShell should remount with ≥1 render-host page webview after recovering from a build error',
      ).toBeGreaterThanOrEqual(1)
    } finally {
      fs.writeFileSync(jsFile, original)
    }
  })
})
