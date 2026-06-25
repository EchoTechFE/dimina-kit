import { test, expect } from './fixtures'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEMO_APP_DIR,
  closeProject,
  openProjectInUI,
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
  await expect(visibilityGroup.locator('button[title="隐藏模拟器"], button[title="显示模拟器"]')).toBeVisible()
  await expect(visibilityGroup.locator('button[title="隐藏编辑器"], button[title="显示编辑器"]')).toBeVisible()
  // The debug region toggle is decoupled from each panel's per-tab `closable`
  // capability: even though the debug panels are `closable:false` (no per-tab ×),
  // the region toggle still hides/shows the whole region as a unit. With the
  // region visible at startup the toggle reads "隐藏调试器"; it is only disabled
  // when debug is the LAST visible region (not the case in the default layout).
  const debugToggle = visibilityGroup.locator('button[title="隐藏调试器"], button[title="显示调试器"]')
  await expect(debugToggle).toBeVisible()

  // Screenshot — resolve test-results relative to THIS spec file so the
  // output lands inside packages/devtools/test-results regardless of cwd.
  const here = path.dirname(fileURLToPath(import.meta.url))
  const outDir = path.resolve(here, '..', 'test-results')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  await mainWindow.screenshot({ path: path.join(outDir, 'toolbar-final.png') })
})

test.afterEach(async ({ mainWindow }) => {
  await closeProject(mainWindow)
})
