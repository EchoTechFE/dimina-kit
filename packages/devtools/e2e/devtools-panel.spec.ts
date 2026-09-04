import { test, expect, useSharedProject } from './fixtures'
import {
  DEMO_APP_DIR,
  findButtonByText,
} from './helpers'
import { DEVICE_NAMES } from '@devicekit/devices'

test.describe('Simulator Panel', () => {
  test.describe.configure({ mode: 'serial' })

  useSharedProject(test, DEMO_APP_DIR)

  test('toolbar has compile and simulator toggle buttons', async ({ workbench }) => {
    expect(await findButtonByText(workbench, '普通编译')).toBe(true)
    await expect(workbench.getByRole('group', { name: '面板可见性' })).toBeVisible()
    await expect(workbench.getByTestId('layout-toolbar-toggle-simulator')).toBeVisible()
  })

  test('toolbar has built-in right panel tabs', async ({ workbench }) => {
    const tabLabels = await workbench.evaluate(() => {
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

  test('can toggle simulator panel visibility', async ({ workbench }) => {
    // Under native-host (now the default runtime) the simulator is a
    // main-process WebContentsView, NOT a renderer `<webview>` — SimulatorPanel
    // deliberately skips the `<webview>` (Electron forbids nesting webviews, so
    // DeviceShell's per-page render-host webviews can only attach to a top-level
    // WCV). So `workbench.locator('webview')` is 0 in BOTH states and can't
    // gate visibility.
    //
    // The observable visibility signal in the workbench DOM is the
    // SimulatorPanel itself: its device-picker `<select>` (the only `<select>`
    // carrying the device options, e.g. `iPhone SE (3rd gen)`) mounts when the simulator
    // cell is in the compiled layout and unmounts when the cell is pruned. The
    // toolbar toggle flips `layoutStore.simulatorVisible`, which the layout
    // compile pass turns into the cell being present/absent (collapseInvisibleCells).
    const deviceSelect = workbench.locator(`select:has(option[value="${DEVICE_NAMES.iPhone_SE_3rd_gen}"])`)
    const toggle = workbench.getByTestId('layout-toolbar-toggle-simulator')

    await expect(deviceSelect).toHaveCount(1)

    await toggle.click()
    await expect(deviceSelect).toHaveCount(0)

    await toggle.click()
    await expect(deviceSelect).toHaveCount(1)
  })

  test('right panel tabs are rendered in the workbench window', async ({ workbench }) => {
    const tabLabels = await workbench.evaluate(() => {
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
