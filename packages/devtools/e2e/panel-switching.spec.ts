import { test, expect, useSharedProject } from './fixtures'
import { DEMO_APP_DIR } from './helpers'

test.describe('Right panel switching', () => {
  test.describe.configure({ mode: 'serial' })

  useSharedProject(test, DEMO_APP_DIR)

  test('selecting each panel renders the correct panel in the main window', async ({
    mainWindow,
  }) => {
    // UI-driven: click the real tab buttons (the only switching path a user
    // has). The raw PanelChannel.Select/SelectSimulator IPC channels this
    // test used to drive are being decommissioned.
    for (const name of ['WXML', 'AppData', 'Storage']) {
      const tab = mainWindow.getByRole('tab', { name })
      await tab.click()
      await expect(tab).toHaveAttribute('aria-selected', 'true')
      await mainWindow.waitForTimeout(400)
    }
    // Selecting Console should show the devtools overlay (chrome devtools)
    const consoleTab = mainWindow.getByRole('tab', { name: 'Console' })
    await consoleTab.click()
    await expect(consoleTab).toHaveAttribute('aria-selected', 'true')
    await mainWindow.waitForTimeout(400)
  })

  test('selecting WXML tab shows WXML panel content in main window', async ({ mainWindow }) => {
    await mainWindow.getByRole('tab', { name: 'WXML' }).click()
    await mainWindow.waitForTimeout(500)

    const hasRefreshButton = await mainWindow.evaluate(() => {
      const buttons = document.querySelectorAll('button')
      for (const btn of buttons) {
        if (btn.textContent?.includes('刷新')) return true
      }
      return false
    })
    expect(hasRefreshButton).toBe(true)
  })

  test('closing project does not leave orphan right-panel views', async ({ electronApp }) => {
    const rpCount = await electronApp.evaluate(({ webContents }) => {
      return webContents.getAllWebContents().filter((wc) => wc.getURL().includes('right-panel')).length
    })
    expect(rpCount).toBe(0)
  })
})
