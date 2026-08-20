import { test, expect } from './fixtures'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEMO_APP_DIR,
  closeProject,
  evalInWebContentsByUrl,
  openProjectInUI,
  pollUntil,
  waitForEditorReady,
} from './helpers'

/**
 * Visual capture of the refactored project toolbar after the right-pane
 * tab switcher (DevTools/WXML/AppData/Storage) was removed in favour of
 * BottomDebugPanel. Verifies that:
 *
 *   1. The toolbar no longer renders any [role="tab"] inside the header
 *      band — the only tablist on the page is the bottom debug bar.
 *   2. The compile-mode dropdown trigger ("普通编译 ▾") is present.
 *   3. The section visibility toggle group is present.
 *
 * Screenshot is written next to packages/devtools/test-results/ so the
 * file location is stable regardless of which cwd Playwright is launched
 * from.
 */
test('toolbar: refactored visual layout (no right-pane tabs, compile-mode dropdown, pane toggle)', async ({ mainWindow }) => {
  await openProjectInUI(mainWindow, DEMO_APP_DIR)
  await waitForEditorReady(mainWindow)

  // 1. The toolbar header band must not host any tab switcher: the old
  //    right-pane DevTools/WXML/AppData/Storage tabs are gone. Every remaining
  //    `[role="tab"]` is a DOCK tab and therefore lives inside a
  //    `[data-deck-group]`; none stray into the toolbar/header.
  const stragglingTabs = await mainWindow.$$eval(
    '[role="tab"]',
    (els) =>
      els
        .filter((el) => !el.closest('[data-deck-group]'))
        .map((el) => el.textContent?.trim() ?? ''),
  )
  expect(stragglingTabs, 'no [role="tab"] should live outside the dock (the toolbar has no tab switcher)').toEqual([])

  // The dock tablist is EXACTLY the five debug panels (simulator + editor are
  // tabless structural panels) — assert the precise set so a stray tab can't slip
  // back in unnoticed.
  const dockTabIds = await mainWindow.$$eval('[data-deck-tab]', (els) =>
    els.map((el) => el.getAttribute('data-deck-tab')),
  )
  expect([...dockTabIds].sort(), 'the dock tablist must be exactly the five debug tabs').toEqual(
    ['appdata', 'compile', 'console', 'storage', 'wxml'],
  )

  // 2. Compile-mode dropdown trigger exists in the toolbar.
  const compileBtn = mainWindow.getByRole('button', { name: /普通编译/ })
  await expect(compileBtn).toBeVisible()

  // 3. Section visibility toggles live in a labelled toolbar group.
  const visibilityGroup = mainWindow.getByRole('group', { name: '面板可见性' })
  await expect(visibilityGroup).toBeVisible()
  await expect(visibilityGroup.getByRole('button', { name: /^(隐藏|显示)模拟器$/ })).toBeVisible()
  await expect(visibilityGroup.getByRole('button', { name: /^(隐藏|显示)编辑器$/ })).toBeVisible()
  // The debug region toggle is decoupled from each panel's per-tab `closable`
  // capability: even though the debug panels are `closable:false` (no per-tab ×),
  // the region toggle still hides/shows the whole region as a unit. With the
  // region visible at startup the toggle reads "隐藏调试器"; it is only disabled
  // when debug is the LAST visible region (not the case in the default layout).
  const debugToggle = visibilityGroup.getByRole('button', { name: /^(隐藏|显示)调试器$/ })
  await expect(debugToggle).toBeVisible()

  // Toolbar controls need their own interaction surfaces: --qd-muted is the
  // same color as the light toolbar chrome, so the generic ghost hover is
  // invisible here. Verify the settled hover paint differs from the row.
  const alignmentToggle = mainWindow.getByTestId('layout-toolbar-alignment-toggle')
  const toolbarColor = await alignmentToggle.evaluate((node) =>
    getComputedStyle(node.closest('.bg-surface-2')!).backgroundColor,
  )
  await alignmentToggle.hover()
  await expect.poll(() => alignmentToggle.evaluate((node) =>
    getComputedStyle(node).backgroundColor,
  )).not.toBe(toolbarColor)
  await mainWindow.mouse.move(1, 1)

  // Screenshot — resolve test-results relative to THIS spec file so the
  // output lands inside packages/devtools/test-results regardless of cwd.
  const here = path.dirname(fileURLToPath(import.meta.url))
  const outDir = path.resolve(here, '..', 'test-results')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  await mainWindow.screenshot({ path: path.join(outDir, 'toolbar-final.png') })
})

test('toolbar: native tooltip measures content and survives a second hover', async ({ mainWindow, electronApp }) => {
  await openProjectInUI(mainWindow, DEMO_APP_DIR)
  await waitForEditorReady(mainWindow)

  const surfaceState = () => electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes('entries/main'),
    )
    if (!win) return null
    for (const child of win.contentView.children) {
      const view = child as unknown as {
        webContents?: { getURL(): string }
        getBounds(): { x: number; y: number; width: number; height: number }
      }
      if (view.webContents?.getURL().includes('entries/tooltip')) return view.getBounds()
    }
    return null
  })

  await mainWindow.getByRole('button', { name: '重新编译' }).hover()
  const firstText = await pollUntil(
    () => evalInWebContentsByUrl<string>(electronApp, 'entries/tooltip', 'document.body.innerText'),
    (text) => text.trim() === '重新编译',
    10_000,
  )
  const firstBounds = await pollUntil(surfaceState, (bounds) => bounds !== null, 10_000)
  expect(firstBounds, 'the measured tooltip must attach to the main window').not.toBeNull()
  expect(firstText.trim()).toBe('重新编译')
  expect(firstBounds!.width).toBeGreaterThan(20)
  expect(firstBounds!.width).toBeLessThan(160)

  await mainWindow.getByRole('button', { name: '设置' }).hover()
  const secondText = await pollUntil(
    () => evalInWebContentsByUrl<string>(electronApp, 'entries/tooltip', 'document.body.innerText'),
    (text) => text.trim() === '设置',
    10_000,
  )
  const secondBounds = await pollUntil(surfaceState, (bounds) => bounds !== null, 10_000)
  expect(secondText.trim()).toBe('设置')
  expect(secondBounds!.width).toBeLessThan(firstBounds!.width)

  await mainWindow.mouse.move(1, 1)
  await pollUntil(surfaceState, (bounds) => bounds === null, 10_000)
})

test.afterEach(async ({ mainWindow }) => {
  await closeProject(mainWindow)
})
