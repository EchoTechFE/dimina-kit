import { test, expect, useSharedProject } from './fixtures'
import { DEMO_APP_DIR } from './helpers'

test.describe('AppData Panel Edit Write-Back', () => {
  test.setTimeout(90_000)
  test.describe.configure({ mode: 'serial' })

  useSharedProject(test, DEMO_APP_DIR)

  test('editing a value in the tree round-trips through service→render setData and re-renders from the pushed snapshot', async ({ mainWindow }) => {
    await mainWindow.getByRole('tab', { name: 'AppData' }).click()

    // Pages sidebar lists the running page; the demo app's first page is
    // pages/index/index and its bridge auto-activates (useActiveBridgeId
    // follows the simulator's active page path), so the data tree for it is
    // already the visible one once data arrives.
    const pages = mainWindow.getByTestId('appdata-pages')
    await expect(pages).toBeVisible({ timeout: 30_000 })
    await expect(pages).toContainText('pages/index/index', { timeout: 30_000 })

    const tree = mainWindow.getByTestId('appdata-tree')
    await expect(tree).toBeVisible({ timeout: 30_000 })

    // The root row starts expanded but its children start collapsed; open
    // the `menuItems` array to reach its elements. Opening an array also
    // opens its object elements one level (see appdata-tree.tsx toggle), so
    // `menuItems[0].title` becomes reachable in this one click.
    await tree.getByText('menuItems', { exact: true }).click()

    const titleRow = tree.locator('[data-path="menuItems[0].title"]')
    await expect(titleRow).toBeVisible({ timeout: 10_000 })
    const valueCell = titleRow.getByTestId('appdata-value')
    await expect(valueCell).toHaveText('Console 输出测试')

    const newValue = 'E2E-写回-appdata-edit-regression'
    await valueCell.dblclick()
    const input = tree.getByRole('textbox')
    await expect(input).toBeVisible()
    await input.fill(newValue)
    await input.press('Enter')

    // The panel never locally echoes an edit — commitEdit only calls
    // onSetData and pushes an undo record; the rendered value keeps coming
    // from `state.entries`, which only changes when a new AppDataSnapshot
    // arrives. So this text showing up in the tree proves the full
    // round trip: renderer IPC write → main SimulatorAppDataChannel.SetData
    // → service-host preload → page.setData → the resulting `ub` update
    // message flowing back through main → a pushed snapshot re-rendering
    // the tree with the new value.
    await expect(tree).toContainText(newValue, { timeout: 10_000 })
  })
})
