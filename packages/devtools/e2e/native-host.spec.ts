import path from 'path'
import { fileURLToPath } from 'url'
import type { ElectronApplication } from '@playwright/test'
import { test, expect, useSharedProject } from './fixtures'
import {
  DEMO_APP_DIR,
  ipcInvoke,
  ipcSend,
  pollUntil,
} from './helpers'

// This spec drives the native-host SERVICE path directly over `dmb:spawn` IPC
// (the bridge-router handlers are registered regardless of DIMINA_NATIVE_HOST),
// so it needs no env flag. Do NOT set `process.env.DIMINA_NATIVE_HOST` here — a
// module-top mutation poisons the shared --workers=1 runner and flips every
// other spec into native-host mode.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_BUNDLE = path.resolve(__dirname, 'fixtures', 'native-host-bundle')

interface SystemInfoResult {
  brand?: string
  platform?: string
  version?: string
}

interface SpawnResult {
  appSessionId: string
  bridgeId: string
  pagePath: string
  serviceWcId: number
  resourceBaseUrl: string
  manifest: {
    entryPagePath: string
    pages: string[]
    tabBar?: { list: Array<{ pagePath: string; text?: string }> }
  }
  rootWindowConfig: Record<string, unknown>
}

async function evalInServiceHost<T = unknown>(
  electronApp: ElectronApplication,
  expression: string,
): Promise<T> {
  return electronApp.evaluate(async ({ webContents }, expr) => {
    const service = webContents.getAllWebContents().find((wc) =>
      !wc.isDestroyed() && wc.getURL().includes('/service-host/service.html')
    )
    if (!service) throw new Error('No service host webContents found')
    return service.executeJavaScript(expr)
  }, expression) as Promise<T>
}

async function waitForServiceHost(electronApp: ElectronApplication): Promise<void> {
  await pollUntil(
    async () =>
      electronApp.evaluate(({ webContents }) =>
        webContents.getAllWebContents().some((wc) =>
          !wc.isDestroyed() && wc.getURL().includes('/service-host/service.html'),
        ),
      ),
    (value) => value === true,
    20_000,
    250,
  )
}

test.describe('Native host', () => {
  test.setTimeout(90_000)
  test.describe.configure({ mode: 'serial' })

  useSharedProject(test, DEMO_APP_DIR, { openOptions: { waitMs: 8000 } })

  test('spawn returns SpawnResult shape with manifest + tabBar parsed from fixture', async ({ mainWindow }) => {
    const result = await ipcInvoke<SpawnResult>(mainWindow, 'dmb:spawn', {
      appId: 'native-host-e2e',
      pagePath: 'pages/index/index',
      pkgRoot: FIXTURE_BUNDLE,
      root: 'main',
    })

    expect(result.appSessionId).toEqual(expect.any(String))
    expect(result.bridgeId).toEqual(result.appSessionId)
    expect(result.serviceWcId).toBeGreaterThan(0)
    expect(result.resourceBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect(result.manifest.entryPagePath).toBe('pages/index/index')
    expect(result.manifest.pages).toContain('pages/index/index')
    expect(result.manifest.tabBar?.list).toHaveLength(3)
    expect(result.rootWindowConfig.navigationBarTitleText).toBe('Home')

    await ipcSend(mainWindow, 'dmb:dispose', { bridgeId: result.appSessionId })
  })

  test('service host exposes DiminaServiceBridge + wx globals after spawn', async ({ mainWindow, electronApp }) => {
    // The previous version of this test invoked `wx.getSystemInfo({success})`
    // and waited for the host-env snapshot to arrive on `globalThis`. That
    // path proved unreliable in CI: the upstream service bundle handles many
    // wx APIs asynchronously via service↔main IPC, so under timing pressure
    // the success callback never fires inside the 10s window.
    //
    // What the e2e really needs to assert is that the service-host preload
    // wired *something* up: DiminaServiceBridge exists, `wx` is an object,
    // and the sync-api-patch had a chance to install at least one sync
    // helper. Behaviour of the async wx.getSystemInfo path is covered by
    // unit tests over sync-impls and by the simulator integration spec.
    const result = await ipcInvoke<SpawnResult>(mainWindow, 'dmb:spawn', {
      appId: 'native-host-e2e',
      pagePath: 'pages/index/index',
      pkgRoot: FIXTURE_BUNDLE,
      root: 'main',
    })

    await waitForServiceHost(electronApp)

    const bridgeType = await pollUntil(
      () => evalInServiceHost<string>(electronApp, 'typeof globalThis.DiminaServiceBridge'),
      (v) => v === 'object',
      15_000,
      250,
    )
    expect(bridgeType).toBe('object')

    const wxType = await evalInServiceHost<string>(electronApp, 'typeof globalThis.wx')
    expect(wxType).toBe('object')

    // sync-api-patch.ts overrides getSystemInfoSync to read from the spawn
    // context's host-env snapshot; if the patch ran successfully we can
    // invoke it without hitting an "undefined is not a function".
    const hasSync = await evalInServiceHost<boolean>(
      electronApp,
      'typeof globalThis.wx.getSystemInfoSync === "function"',
    )
    expect(hasSync).toBe(true)

    await ipcSend(mainWindow, 'dmb:dispose', { bridgeId: result.appSessionId })
  })

  test('PAGE_OPEN allocates a new bridgeId + merged windowConfig', async ({ mainWindow }) => {
    const spawnResult = await ipcInvoke<SpawnResult>(mainWindow, 'dmb:spawn', {
      appId: 'native-host-e2e',
      pagePath: 'pages/index/index',
      pkgRoot: FIXTURE_BUNDLE,
      root: 'main',
    })

    const opened = await ipcInvoke<{
      bridgeId: string
      pagePath: string
      windowConfig: { navigationBarTitleText?: string }
      isTab: boolean
    }>(mainWindow, 'dmb:page:open', {
      appSessionId: spawnResult.appSessionId,
      pagePath: 'pages/detail/detail',
      query: { id: '42' },
    })

    expect(opened.bridgeId).not.toBe(spawnResult.bridgeId)
    expect(opened.pagePath).toBe('pages/detail/detail')
    expect(opened.isTab).toBe(false)
    expect(opened.windowConfig.navigationBarTitleText).toBe('Detail')

    // Tab page lookup
    const cart = await ipcInvoke<{ isTab: boolean; windowConfig: { navigationBarTitleText?: string } }>(
      mainWindow,
      'dmb:page:open',
      {
        appSessionId: spawnResult.appSessionId,
        pagePath: 'pages/cart/cart',
      },
    )
    expect(cart.isTab).toBe(true)
    expect(cart.windowConfig.navigationBarTitleText).toBe('Cart')

    await ipcSend(mainWindow, 'dmb:dispose', { bridgeId: spawnResult.appSessionId })
  })
})
