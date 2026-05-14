import { test, expect } from './fixtures'
import {
  DEMO_APP_DIR,
  openProjectInUI,
  closeProject,
  ipcInvoke,
  evalInWebContentsByUrl,
  pollUntil,
} from './helpers'
import { SettingsChannel, ProjectChannel, ProjectsChannel } from '../src/shared/ipc-channels'

test.describe('Settings', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitForWebview: true })
  })

  test.afterEach(async ({ mainWindow }) => {
    await closeProject(mainWindow)
    await ipcInvoke(mainWindow, ProjectsChannel.Remove, DEMO_APP_DIR).catch(() => {})
  })

  test('settings view can be shown', async ({ mainWindow, electronApp }) => {
    await ipcInvoke(mainWindow, SettingsChannel.SetVisible, true)

    const text = await pollUntil(
      () => evalInWebContentsByUrl<string>(electronApp, 'entries/settings', `document.body.innerText`),
      (value) => value.includes('本地设置') && value.includes('项目配置'),
      10000
    )

    expect(text).toContain('本地设置')
  })

  test('settings view receives current project path', async ({ mainWindow, electronApp }) => {
    await ipcInvoke(mainWindow, SettingsChannel.SetVisible, true)
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

    await ipcInvoke(mainWindow, SettingsChannel.SetVisible, true)
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
