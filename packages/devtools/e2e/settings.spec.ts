import { test, expect } from './fixtures'
import type { ElectronApplication, Page } from '@playwright/test'
import {
  DEMO_APP_DIR,
  openProjectInUI,
  closeProject,
  ipcInvoke,
  evalInWebContentsByUrl,
  pollUntil,
} from './helpers'
import { ProjectsChannel } from '../src/shared/ipc-channels'

/**
 * UI-driven settings flow. The embedded settings overlay is opened the way a
 * USER opens it — clicking the toolbar's 设置 button — instead of the previous
 * raw `ipcInvoke('settings:setVisible', true)` backdoor, which kept passing
 * even while the overlay was unreachable from the actual UI.
 */
async function openSettingsViaUI(workbench: Page, electronApp: ElectronApplication): Promise<void> {
  const settingsButton = workbench.getByRole('button', { name: '设置' })
  await expect(settingsButton).toBeVisible({ timeout: 15_000 })
  await settingsButton.click()
  // The click is fire-and-forget from Playwright's perspective: it drives
  // invoke('settings:setVisible', true) and main creates the overlay WCV
  // lazily. Wait until the overlay webContents is reachable so callers can
  // immediately evaluate into it without racing its creation.
  await pollUntil(
    () => evalInWebContentsByUrl<number>(electronApp, 'entries/settings', '1'),
    (value) => value === 1,
    10_000,
  )
}

test.describe('Settings', () => {
  test.beforeEach(async ({ electronApp }) => {
    await openProjectInUI(electronApp, DEMO_APP_DIR)
  })

  test.afterEach(async ({ mainWindow, electronApp }) => {
    await closeProject(electronApp)
    await ipcInvoke(mainWindow, ProjectsChannel.Remove, DEMO_APP_DIR).catch(() => {})
  })

  test('settings view opens from the toolbar 设置 button', async ({ workbench, electronApp }) => {
    await openSettingsViaUI(workbench, electronApp)

    const text = await pollUntil(
      () => evalInWebContentsByUrl<string>(electronApp, 'entries/settings', `document.body.innerText`),
      (value) => value.includes('本地设置') && value.includes('项目配置'),
      10000
    )

    expect(text).toContain('本地设置')
  })

  test('settings view receives current project path', async ({ workbench, electronApp }) => {
    await openSettingsViaUI(workbench, electronApp)
    await evalInWebContentsByUrl(
      electronApp,
      'entries/settings',
      `(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((el) => el.textContent?.includes('项目配置'))
        if (!btn) return false
        btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
        btn.click()
        return true
      })()`
    )

    const text = await pollUntil(
      () => evalInWebContentsByUrl<string>(electronApp, 'entries/settings', `document.body.innerText`),
      (value) => value.includes('项目配置') && value.includes(DEMO_APP_DIR),
      10000
    )

    expect(text).toContain('项目配置')
    expect(text).toContain(DEMO_APP_DIR)
  })
})
