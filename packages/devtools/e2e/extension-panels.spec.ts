import { test, expect, useSharedProject } from './fixtures'
import {
  DEMO_APP_DIR,
  evalInSimulator,
  ipcInvoke,
  pollUntil,
} from './helpers'
import { SimulatorStorageChannel } from '../src/shared/ipc-channels'

test.describe('Extension Panels Data Bridge', () => {
  test.setTimeout(90_000)
  test.describe.configure({ mode: 'serial' })

  useSharedProject(test, DEMO_APP_DIR, { openOptions: { waitMs: 8000 } })

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
    // The WXML panel has no manual refresh button (it's live): it seeds on
    // activation and stays reactive via the render-guest DOM observer. Wait for
    // the panel container, then poll for the tree.
    await mainWindow.getByTestId('wxml-panel').waitFor({ timeout: 8000 })

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

  test('Storage panel renders in main window after tab switch', async ({ mainWindow }) => {
    await mainWindow.getByRole('tab', { name: 'Storage' }).click()
    // The Storage panel has no manual refresh button (it's live). Wait for the
    // panel container to mount.
    await mainWindow.getByTestId('storage-panel').waitFor({ timeout: 8000 })

    // Under native-host the Storage panel is sourced from the main-process
    // service-host `file://` store (serviceStorage), NOT the simulator
    // webview's DOMStorage. `GetSnapshot` reads that store filtered by the
    // active appId prefix, and `Set` routes to `serviceStorage.writeOne` —
    // the same store — so writing a `${prefix}…` key via the SAME IPC the
    // panel's own write path uses is what lands in the panel. A direct
    // `localStorage.setItem` in the simulator would never reach it.
    //
    // We must drive `Set` through `mainWindow`'s IPC bridge (the renderer's
    // sender) — the storage channels are sender-gated to the workbench
    // policy, so an arbitrary main-process call would be rejected.
    const prefix = await ipcInvoke<string>(mainWindow, SimulatorStorageChannel.GetActivePrefix)
    expect(prefix, 'active storage prefix should resolve under native-host').toBeTruthy()
    const key = `${prefix}e2e_storage_key`

    const set = await ipcInvoke<{ ok: boolean }>(
      mainWindow,
      SimulatorStorageChannel.Set,
      { key, value: 'e2e_storage_value' },
    )
    expect(set?.ok, 'Set should succeed against the service-host store').toBe(true)

    // The synthetic `added` event pushed after the write keeps the panel
    // reactive; the panel also seeds via GetSnapshot on activation/ready.
    // Assert the key renders in the panel DOM — this catches a regression of
    // the panel never receiving service-host storage data after a tab switch.
    const text = await pollUntil(
      () => mainWindow.evaluate(() => document.body.innerText),
      (value) => value.includes('e2e_storage_key'),
      15000,
    )
    expect(text).toContain('e2e_storage_key')
  })

  test('AppData panel renders in main window after tab switch', async ({ mainWindow }) => {
    await mainWindow.getByRole('tab', { name: 'AppData' }).click()
    const panel = mainWindow.getByTestId('appdata-panel')
    await panel.waitFor({ timeout: 8000 })
    await expect(panel).toBeVisible()
  })

  test('no orphan right-panel WebContentsView exists', async ({ electronApp }) => {
    const rpCount = await electronApp.evaluate(({ webContents }) => {
      return webContents.getAllWebContents().filter((wc) => wc.getURL().includes('right-panel')).length
    })
    expect(rpCount).toBe(0)
  })
})
