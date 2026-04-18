/**
 * Relaunch & compile resilience tests.
 * Tests extreme edge cases: page switching, rapid changes, build errors,
 * file deletion, recovery, and race conditions.
 */
import fs from 'fs'
import path from 'path'
import { test, expect } from './fixtures'
import {
  DEMO_APP_DIR,
  openProjectInUI,
  closeProject,
  pollUntil,
} from './helpers'

// ── Helpers ──────────────────────────────────────────────────────────────

async function getStatus(mainWindow: import('@playwright/test').Page) {
  return mainWindow.evaluate(
    () => document.querySelector('[class*="truncate"]')?.textContent || '',
  )
}

async function getChildViews(electronApp: import('@playwright/test').ElectronApplication) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    return (win?.contentView.children || []).length
  })
}

async function getWebviewInfo(electronApp: import('@playwright/test').ElectronApplication) {
  return electronApp.evaluate(({ webContents }) => {
    const sim = webContents.getAllWebContents().find((wc) => wc.getType() === 'webview')
    if (!sim) return null
    return { url: sim.getURL(), crashed: sim.isCrashed() }
  })
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
  await mainWindow.waitForTimeout(800)

  const popoverWcId = await electronApp.evaluate(({ webContents }) =>
    webContents.getAllWebContents().find((wc) => wc.getURL().includes('entries/popover'))?.id || 0,
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
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 10000, waitForWebview: true })
  })

  test.afterEach(async ({ mainWindow }) => {
    await closeProject(mainWindow)
  })

  test('↺ button reloads same page successfully', async ({ mainWindow, electronApp }) => {
    await clickRelaunchButton(mainWindow)
    const status = await waitForStatus(mainWindow, ['刷新完成', '编译完成'])
    expect(status).toContain('完成')

    const views = await getChildViews(electronApp)
    expect(views).toBeGreaterThanOrEqual(2)
  })

  test('popover page switch navigates correctly', async ({ mainWindow, electronApp }) => {
    await relaunchViaPopover(mainWindow, electronApp, 'storage-test')
    const status = await waitForStatus(mainWindow, ['刷新完成', '编译完成'])
    expect(status).toContain('完成')

    const wv = await getWebviewInfo(electronApp)
    expect(wv).not.toBeNull()
    expect(wv!.url).toContain('storage-test')
    expect(wv!.crashed).toBe(false)

    expect(await getChildViews(electronApp)).toBeGreaterThanOrEqual(2)
  })

  test('multiple sequential page switches all succeed', async ({ mainWindow, electronApp }) => {
    for (const page of ['console-test', 'storage-test', 'index']) {
      await relaunchViaPopover(mainWindow, electronApp, page)
      const status = await waitForStatus(mainWindow, ['刷新完成', '编译完成'])
      expect(status).toContain('完成')
      const wv = await getWebviewInfo(electronApp)
      expect(wv).not.toBeNull()
      expect(wv!.url).toContain(page.replace('-test', ''))
    }
  })

  test('rapid double-click ↺ does not break state', async ({ mainWindow, electronApp }) => {
    await clickRelaunchButton(mainWindow)
    await mainWindow.waitForTimeout(50)
    await clickRelaunchButton(mainWindow)

    const status = await waitForStatus(mainWindow, ['完成', '失败', '超时'])
    expect(status).toContain('完成')
    expect(await getChildViews(electronApp)).toBeGreaterThanOrEqual(2)
  })

  test('rapid file changes do not crash webview', async ({ mainWindow, electronApp }) => {
    const files = ['index.js', 'index.wxml', 'index.wxss'].map((f) =>
      path.join(DEMO_APP_DIR, 'pages', 'index', f),
    )
    const originals = Object.fromEntries(
      files.filter((f) => fs.existsSync(f)).map((f) => [f, fs.readFileSync(f, 'utf8')]),
    )

    // Rapid-fire touch 3 files in 300ms
    for (const f of Object.keys(originals)) {
      fs.writeFileSync(f, originals[f] + `\n// e2e-${Date.now()}`)
      await mainWindow.waitForTimeout(100)
    }

    // Wait for rebuild to settle
    await mainWindow.waitForTimeout(15000)

    const wv = await getWebviewInfo(electronApp)
    expect(wv).not.toBeNull()
    expect(wv!.crashed).toBe(false)
    expect(await getChildViews(electronApp)).toBeGreaterThanOrEqual(2)

    // Restore
    for (const [f, content] of Object.entries(originals)) fs.writeFileSync(f, content)
  })

  test('UI stays usable after build error and recovers', async ({ mainWindow, electronApp }) => {
    const jsFile = path.join(DEMO_APP_DIR, 'pages', 'index', 'index.js')
    const original = fs.readFileSync(jsFile, 'utf8')

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

    // Should be able to relaunch after recovery
    await clickRelaunchButton(mainWindow)
    await waitForStatus(mainWindow, ['完成', '失败', '超时'])
    expect(await getChildViews(electronApp)).toBeGreaterThanOrEqual(2)
  })
})
