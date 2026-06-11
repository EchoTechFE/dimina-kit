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
import { ProjectChannel, ProjectsChannel } from '../src/shared/ipc-channels'

/**
 * UI-driven settings flow. The embedded settings overlay is opened the way a
 * USER opens it — clicking the toolbar's 设置 button (Wave 2 ④ restores this
 * entry point; until it lands these tests are RED) — instead of the previous
 * raw `ipcInvoke('settings:setVisible', true)` backdoor, which kept passing
 * even while the overlay was unreachable from the actual UI.
 */
async function openSettingsViaUI(mainWindow: Page, electronApp: ElectronApplication): Promise<void> {
  const settingsButton = mainWindow.getByTitle('设置')
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
  test.beforeEach(async ({ mainWindow }) => {
    await openProjectInUI(mainWindow, DEMO_APP_DIR)
  })

  test.afterEach(async ({ mainWindow }) => {
    await closeProject(mainWindow)
    await ipcInvoke(mainWindow, ProjectsChannel.Remove, DEMO_APP_DIR).catch(() => {})
  })

  test('settings view opens from the toolbar 设置 button', async ({ mainWindow, electronApp }) => {
    await openSettingsViaUI(mainWindow, electronApp)

    const text = await pollUntil(
      () => evalInWebContentsByUrl<string>(electronApp, 'entries/settings', `document.body.innerText`),
      (value) => value.includes('本地设置') && value.includes('项目配置'),
      10000
    )

    expect(text).toContain('本地设置')
  })

  test('settings view receives current project path', async ({ mainWindow, electronApp }) => {
    await openSettingsViaUI(mainWindow, electronApp)
    await evalInWebContentsByUrl(
      electronApp,
      'entries/settings',
      `Array.from(document.querySelectorAll('button')).find((btn) => btn.textContent?.includes('项目配置'))?.click()`
    )

    const text = await pollUntil(
      () => evalInWebContentsByUrl<string>(electronApp, 'entries/settings', `document.body.innerText`),
      (value) => value.includes('项目配置') && value.includes(DEMO_APP_DIR),
      10000
    )

    expect(text).toContain('项目配置')
    expect(text).toContain(DEMO_APP_DIR)
  })

  test('settings configChanged persists compile config', async ({ mainWindow, electronApp }) => {
    const original = await ipcInvoke<{
      startPage: string
      scene: number
      queryParams: Array<{ key: string; value: string }>
    }>(mainWindow, ProjectChannel.GetCompileConfig, DEMO_APP_DIR)

    const nextConfig = {
      startPage: 'pages/network-test/network-test',
      scene: 2001,
      queryParams: [{ key: 'from', value: 'e2e' }],
    }

    await openSettingsViaUI(mainWindow, electronApp)
    await evalInWebContentsByUrl(
      electronApp,
      'entries/settings',
      `window.devtools.ipc.send('settings:configChanged', ${JSON.stringify(nextConfig)})`
    )

    const saved = await ipcInvoke<{
      startPage: string
      scene: number
      queryParams: Array<{ key: string; value: string }>
    }>(mainWindow, ProjectChannel.GetCompileConfig, DEMO_APP_DIR)

    expect(saved).toEqual(nextConfig)

    await evalInWebContentsByUrl(
      electronApp,
      'entries/settings',
      `window.devtools.ipc.send('settings:configChanged', ${JSON.stringify(original)})`
    )
  })
})
