import type { Page } from '@playwright/test'
import { test, expect, useSharedProject } from './fixtures'
import {
  DEMO_APP_DIR,
  evalInSimulator,
  ipcInvoke,
} from './helpers'
import { SimulatorStorageChannel } from '../src/shared/ipc-channels'

/**
 * UI-level e2e for the Storage right-panel.
 *
 * Each test drives the panel through real DOM events (input typing, clicks,
 * Enter/Escape, the native confirm dialog) and then reads the simulator's
 * localStorage via the main process to prove the write actually landed in the
 * <webview> — that's the "同步到 simulator" contract.
 *
 * Why `window.confirm` is monkey-patched per test instead of Playwright's
 * `page.on('dialog')`: Electron renders the simulator inside a <webview> with
 * its own webContents, and we've seen Playwright's dialog handler race the
 * test's click in this environment. Replacing `window.confirm` in the renderer
 * before each clear-all interaction is deterministic and local.
 */

const DEMO_APP_ID = 'devtools_demo_001'
const PREFIX = `${DEMO_APP_ID}_`

async function selectStorageTab(mainWindow: Page) {
  // PanelChannel.Select only hides the simulator view; it does not flip the
  // controlled right-pane tab. Click the actual tab so React swaps the
  // StoragePanel into the DOM, then wait for one of its footer-only controls
  // before the test proceeds.
  await mainWindow.getByRole('tab', { name: 'Storage' }).click()
  await mainWindow.getByRole('button', { name: '+ 新增' }).waitFor({ state: 'visible', timeout: 5000 })
}

test.describe('Storage panel — UI editing', () => {
  test.describe.configure({ mode: 'serial' })

  useSharedProject(test, DEMO_APP_DIR, { openOptions: { waitForWebview: true } })

  test('add a new entry via the footer form writes through to the simulator', async ({ mainWindow, electronApp }) => {
    await selectStorageTab(mainWindow)

    const keyInput = mainWindow.locator('input[placeholder="key"]')
    const valueInput = mainWindow.locator('input[placeholder="value"]')
    const addBtn = mainWindow.getByRole('button', { name: '+ 新增' })

    await keyInput.fill('e2e_add_key')
    await valueInput.fill('e2e_add_value')
    await addBtn.click()

    // Row appears with the prefixed key + raw value.
    const row = mainWindow.locator('tr', { has: mainWindow.locator(`td:has-text("${PREFIX}e2e_add_key")`) })
    await expect(row).toBeVisible({ timeout: 5000 })
    await expect(row.locator('td').nth(1)).toHaveText('e2e_add_value')

    // Authoritative check: the simulator's localStorage really got written.
    const v = await evalInSimulator<string | null>(
      electronApp,
      `localStorage.getItem('${PREFIX}e2e_add_key')`,
    )
    expect(v).toBe('e2e_add_value')

    // Inputs cleared on success — guards against the form lingering after submit.
    await expect(keyInput).toHaveValue('')
    await expect(valueInput).toHaveValue('')
  })

  test('inline edit on a value cell commits via Enter and updates the simulator', async ({ mainWindow, electronApp }) => {
    // Seed via IPC so the test only asserts the edit, not the add flow.
    await ipcInvoke(mainWindow, SimulatorStorageChannel.Set, {
      key: `${PREFIX}e2e_edit_key`,
      value: 'before',
    })
    await selectStorageTab(mainWindow)

    const row = mainWindow.locator('tr', { has: mainWindow.locator(`td:has-text("${PREFIX}e2e_edit_key")`) })
    await expect(row).toBeVisible({ timeout: 5000 })
    const valueCell = row.locator('td').nth(1)
    await expect(valueCell).toHaveText('before')

    await valueCell.click()
    const editor = valueCell.locator('input')
    await expect(editor).toBeVisible()
    await editor.fill('after')
    await editor.press('Enter')

    await expect(valueCell).toHaveText('after', { timeout: 5000 })

    const v = await evalInSimulator<string | null>(
      electronApp,
      `localStorage.getItem('${PREFIX}e2e_edit_key')`,
    )
    expect(v).toBe('after')
  })

  test('inline edit cancels on Escape without writing', async ({ mainWindow, electronApp }) => {
    await ipcInvoke(mainWindow, SimulatorStorageChannel.Set, {
      key: `${PREFIX}e2e_esc_key`,
      value: 'keep',
    })
    await selectStorageTab(mainWindow)

    const row = mainWindow.locator('tr', { has: mainWindow.locator(`td:has-text("${PREFIX}e2e_esc_key")`) })
    const valueCell = row.locator('td').nth(1)
    await valueCell.click()
    const editor = valueCell.locator('input')
    await editor.fill('discarded')
    await editor.press('Escape')

    await expect(valueCell).toHaveText('keep')
    const v = await evalInSimulator<string | null>(
      electronApp,
      `localStorage.getItem('${PREFIX}e2e_esc_key')`,
    )
    expect(v).toBe('keep')
  })

  test('row delete button removes from the simulator', async ({ mainWindow, electronApp }) => {
    await ipcInvoke(mainWindow, SimulatorStorageChannel.Set, {
      key: `${PREFIX}e2e_del_key`,
      value: 'doomed',
    })
    await selectStorageTab(mainWindow)

    const row = mainWindow.locator('tr', { has: mainWindow.locator(`td:has-text("${PREFIX}e2e_del_key")`) })
    await expect(row).toBeVisible({ timeout: 5000 })
    await row.getByTitle('删除').click()

    await expect(row).toHaveCount(0, { timeout: 5000 })
    const v = await evalInSimulator<string | null>(
      electronApp,
      `localStorage.getItem('${PREFIX}e2e_del_key')`,
    )
    expect(v).toBeNull()
  })

  test('"清空" only wipes active-appId keys, leaves foreign prefixes intact', async ({ mainWindow, electronApp }) => {
    await ipcInvoke(mainWindow, SimulatorStorageChannel.Set, {
      key: `${PREFIX}e2e_scoped_a`,
      value: '1',
    })
    await evalInSimulator(electronApp, `localStorage.setItem('foreign_prefix_b', 'x')`)
    await selectStorageTab(mainWindow)

    const row = mainWindow.locator('tr', { has: mainWindow.locator(`td:has-text("${PREFIX}e2e_scoped_a")`) })
    await expect(row).toBeVisible({ timeout: 5000 })
    await mainWindow.getByRole('button', { name: '清空', exact: true }).click()

    await expect(row).toHaveCount(0, { timeout: 5000 })

    expect(await evalInSimulator<string | null>(
      electronApp,
      `localStorage.getItem('${PREFIX}e2e_scoped_a')`,
    )).toBeNull()
    // Foreign prefix survives — verifies the per-key delete loop, not origin-wide clear.
    expect(await evalInSimulator<string | null>(
      electronApp,
      `localStorage.getItem('foreign_prefix_b')`,
    )).toBe('x')

    // Manual cleanup since useSharedProject's resetSimulatorState only clears
    // active-appId keys via `wx.clearStorageSync`.
    await evalInSimulator(electronApp, `localStorage.removeItem('foreign_prefix_b')`)
  })

  test('"清空所有" wipes every key in the simulator origin (after confirm)', async ({ mainWindow, electronApp }) => {
    await ipcInvoke(mainWindow, SimulatorStorageChannel.Set, {
      key: `${PREFIX}e2e_all_a`,
      value: '1',
    })
    await evalInSimulator(electronApp, `localStorage.setItem('foreign_prefix_c', 'y')`)
    await selectStorageTab(mainWindow)

    await mainWindow.evaluate(() => {
      ;(window as unknown as { __origConfirm?: typeof window.confirm }).__origConfirm = window.confirm
      window.confirm = () => true
    })
    try {
      await mainWindow.getByRole('button', { name: '清空所有' }).click()

      const row = mainWindow.locator('tr', { has: mainWindow.locator(`td:has-text("${PREFIX}e2e_all_a")`) })
      await expect(row).toHaveCount(0, { timeout: 5000 })

      expect(await evalInSimulator<string | null>(
        electronApp,
        `localStorage.getItem('${PREFIX}e2e_all_a')`,
      )).toBeNull()
      expect(await evalInSimulator<string | null>(
        electronApp,
        `localStorage.getItem('foreign_prefix_c')`,
      )).toBeNull()
    } finally {
      await mainWindow.evaluate(() => {
        const w = window as unknown as { __origConfirm?: typeof window.confirm }
        if (w.__origConfirm) {
          window.confirm = w.__origConfirm
          delete w.__origConfirm
        }
      })
    }
  })
})
