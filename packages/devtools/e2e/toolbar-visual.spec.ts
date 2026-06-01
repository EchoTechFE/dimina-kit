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

  // 1. The toolbar header band (the [data-bottom-debug-tabs] sibling
  //    that lives at the top of the project-runtime) must not host any
  //    role=tab elements. We check by counting tabs that are NOT inside
  //    [data-bottom-debug-tabs].
  const stragglingTabs = await mainWindow.$$eval(
    '[role="tab"]',
    (els) =>
      els
        .filter((el) => !el.closest('[data-bottom-debug-tabs]'))
        .map((el) => el.textContent?.trim() ?? ''),
  )
  expect(stragglingTabs, 'no [role="tab"] should live outside the bottom debug tab bar').toEqual([])

  // 2. Compile-mode dropdown trigger exists in the toolbar.
  const compileBtn = mainWindow.getByRole('button', { name: /普通编译/ })
  await expect(compileBtn).toBeVisible()

  // 3. Section visibility toggles live in a labelled toolbar group.
  const visibilityGroup = mainWindow.getByRole('group', { name: '面板可见性' })
  await expect(visibilityGroup).toBeVisible()
  await expect(visibilityGroup.locator('button[title="隐藏模拟器"], button[title="显示模拟器"]')).toBeVisible()
  await expect(visibilityGroup.locator('button[title="隐藏编辑器"], button[title="显示编辑器"]')).toBeVisible()
  await expect(visibilityGroup.locator('button[title="隐藏调试器"], button[title="显示调试器"]')).toBeVisible()

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
