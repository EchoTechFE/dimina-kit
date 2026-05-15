import { test, expect, useSharedProject } from './fixtures'
import {
  DEMO_APP_DIR,
  evalInSimulator,
  pollUntil,
} from './helpers'

test.describe('Extension Panels Data Bridge', () => {
  test.setTimeout(90_000)
  test.describe.configure({ mode: 'serial' })

  useSharedProject(test, DEMO_APP_DIR, { openOptions: { waitMs: 8000, waitForWebview: true } })

  test('simulator exposes compat wx APIs in webview', async ({ electronApp }) => {
    const result = await evalInSimulator<{
      hasCanIUse: boolean
      hasRequest: boolean
      hasSystemInfo: boolean
      hasWindowInfo: boolean
      hasStorageInfo: boolean
      hasHook: boolean
    }>(electronApp, `(() => ({
      hasCanIUse: typeof globalThis.wx?.canIUse === 'function',
      hasRequest: typeof globalThis.wx?.request === 'function',
      hasSystemInfo: typeof globalThis.wx?.getSystemInfoSync === 'function',
      hasWindowInfo: typeof globalThis.wx?.getWindowInfo === 'function',
      hasStorageInfo: typeof globalThis.wx?.getStorageInfoSync === 'function',
      hasHook: typeof window.__simulatorHook?.appData === 'function',
    }))()`)

    expect(result).toEqual({
      hasCanIUse: true,
      hasRequest: true,
      hasSystemInfo: true,
      hasWindowInfo: true,
      hasStorageInfo: true,
      hasHook: true,
    })
  })

  test('WXML panel renders in main window after tab switch', async ({ mainWindow }) => {
    await mainWindow.getByRole('tab', { name: 'WXML' }).click()
    // Scope to the WXML panel: AppDataPanel stays keepalive-mounted with its
    // own "↻ 刷新" button, so a global text locator hits 2 elements.
    const wxmlRefresh = mainWindow.getByTestId('wxml-panel').locator('button:has-text("↻ 刷新")')
    await wxmlRefresh.waitFor({ timeout: 8000 })
    // Trigger a fresh fetch — without this we'd race the initial wxml IPC.
    await wxmlRefresh.click()

    // Assert the tree actually renders (not the "等待小程序加载..." empty
    // state). demo-app index.wxml has a <view class="container">, which the
    // panel renders as a node including the tagName 'view' and the class.
    // This catches a regression of the usePanelData IPC-listener race —
    // before the fix, the panel stayed in its empty state because no
    // SimulatorChannel.Wxml events ever reached React state.
    const text = await pollUntil(
      () => mainWindow.evaluate(() => document.body.innerText),
      (value) => value.includes('container') && !value.includes('等待小程序加载'),
      15000
    )

    expect(text).toContain('container')
    expect(text).not.toContain('等待小程序加载')
  })

  test('Storage panel renders in main window after tab switch', async ({ mainWindow, electronApp }) => {
    await mainWindow.getByRole('tab', { name: 'Storage' }).click()
    // Scope to StoragePanel：AppDataPanel keepalive 挂载着另一个「↻ 刷新」按钮。
    await mainWindow.getByTestId('storage-panel').locator('button:has-text("↻ 刷新")').waitFor({ timeout: 8000 })

    // Storage panel filters the CDP DOMStorage stream by the active
    // project's appId prefix (the simulator partition is shared across
    // every project ever opened). Write a key with the same `${appId}_`
    // prefix the dimina runtime uses so the filter passes it through.
    await evalInSimulator(
      electronApp,
      `(() => {
        const hash = location.hash.replace(/^#/, '')
        const appId = hash.includes('|') ? hash.split('|')[0] : hash.split('/')[0]
        localStorage.setItem(appId + '_e2e_storage_key', 'e2e_storage_value')
      })()`,
    )

    const text = await pollUntil(
      () => mainWindow.evaluate(() => document.body.innerText),
      (value) => value.includes('e2e_storage_key'),
      15000,
    )
    expect(text).toContain('e2e_storage_key')
  })

  test('AppData panel renders in main window after tab switch', async ({ mainWindow }) => {
    await mainWindow.getByRole('tab', { name: 'AppData' }).click()
    await mainWindow.waitForTimeout(500)

    const hasPanel = await mainWindow.evaluate(() => {
      return document.body.innerText.includes('刷新') ||
             document.body.innerText.includes('暂无数据') ||
             document.body.innerText.includes('setData')
    })

    expect(hasPanel).toBe(true)
  })

  test('no orphan right-panel WebContentsView exists', async ({ electronApp }) => {
    const rpCount = await electronApp.evaluate(({ webContents }) => {
      return webContents.getAllWebContents().filter((wc) => wc.getURL().includes('right-panel')).length
    })
    expect(rpCount).toBe(0)
  })
})
