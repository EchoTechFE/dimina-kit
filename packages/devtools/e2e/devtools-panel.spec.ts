import { test, expect, useSharedProject } from './fixtures'
import {
  DEMO_APP_DIR,
  findButtonByText,
} from './helpers'

test.describe('Simulator Panel', () => {
  test.describe.configure({ mode: 'serial' })

  useSharedProject(test, DEMO_APP_DIR)

  test('toolbar has compile and simulator toggle buttons', async ({ mainWindow }) => {
    expect(await findButtonByText(mainWindow, '普通编译')).toBe(true)
    await expect(mainWindow.getByRole('group', { name: '面板可见性' })).toBeVisible()
    await expect(mainWindow.getByTestId('layout-toolbar-toggle-simulator')).toBeVisible()
  })

  test('toolbar has built-in right panel tabs', async ({ mainWindow }) => {
    const tabLabels = await mainWindow.evaluate(() => {
      const buttons = document.querySelectorAll('button')
      const labels: string[] = []
      buttons.forEach((btn) => {
        const text = btn.textContent?.trim()
        if (text && ['WXML', 'AppData', 'Storage'].includes(text)) {
          labels.push(text)
        }
      })
      return labels
    })

    expect(tabLabels).toEqual(expect.arrayContaining(['WXML', 'AppData', 'Storage']))
  })

  test('can toggle simulator panel visibility', async ({ mainWindow }) => {
    const toggle = mainWindow.getByTestId('layout-toolbar-toggle-simulator')
    await expect(mainWindow.locator('webview')).toHaveCount(1)

    await toggle.click()
    await expect(mainWindow.locator('webview')).toHaveCount(0)

    await toggle.click()
    await expect(mainWindow.locator('webview')).toHaveCount(1)
  })

  test('right panel tabs are rendered in the main window', async ({ mainWindow }) => {
    const tabLabels = await mainWindow.evaluate(() => {
      const buttons = document.querySelectorAll('button')
      const labels: string[] = []
      buttons.forEach((btn) => {
        const text = btn.textContent?.trim()
        if (text && ['WXML', 'AppData', 'Storage'].includes(text)) {
          labels.push(text)
        }
      })
      return labels
    })
    expect(tabLabels.length).toBeGreaterThan(0)
  })
})
