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
    // Under native-host (now the default runtime) the simulator is a
    // main-process WebContentsView, NOT a renderer `<webview>` — SimulatorPanel
    // deliberately skips the `<webview>` (Electron forbids nesting webviews, so
    // DeviceShell's per-page render-host webviews can only attach to a top-level
    // WCV). So `mainWindow.locator('webview')` is 0 in BOTH states and can't
    // gate visibility.
    //
    // The observable visibility signal in the main-window DOM is the
    // SimulatorPanel itself: its device-picker `<select>` (the only `<select>`
    // carrying the device options, e.g. `iPhone SE`) mounts when the simulator
    // cell is in the compiled layout and unmounts when the cell is pruned. The
    // toolbar toggle flips `layoutStore.simulatorVisible`, which the layout
    // compile pass turns into the cell being present/absent (collapseInvisibleCells).
    const deviceSelect = mainWindow.locator('select:has(option[value="iPhone SE"])')
    const toggle = mainWindow.getByTestId('layout-toolbar-toggle-simulator')

    await expect(deviceSelect).toHaveCount(1)

    await toggle.click()
    await expect(deviceSelect).toHaveCount(0)

    await toggle.click()
    await expect(deviceSelect).toHaveCount(1)
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
