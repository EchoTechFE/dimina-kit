/**
 * Compatibility test: verify that dimina-devtools WebSocket automation server
 * speaks the miniprogram-automator protocol correctly.
 *
 * This proves that existing miniprogram-automator test scripts can connect
 * to and drive our devtools.
 */

import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import { WebSocket } from 'ws'
import { createRequire } from 'module'
import {
  DEMO_APP_DIR,
  openProjectInUI,
  waitForSimulatorWebview,
  closeProject,
  ipcInvoke,
  pollUntil,
} from './helpers'
import { AutomationChannel } from '../src/shared/ipc-channels'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// miniprogram-automator is CJS, need createRequire in ESM context
const require = createRequire(import.meta.url)
const automator = require('miniprogram-automator')

// ── Shared state ──────────────────────────────────────────────────────

let electronApp: ElectronApplication
let mainWindow: PwPage
let autoPort: number

// ── WS helper ─────────────────────────────────────────────────────────

function wsCall(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${autoPort}`)
    const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')) }, 10000)
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: '1', method, params }))
    })
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data))
      if (msg.id === '1') {
        clearTimeout(timeout)
        ws.close()
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result as Record<string, unknown>)
      }
    })
    ws.on('error', (err) => { clearTimeout(timeout); reject(err) })
  })
}

// ── Setup / Teardown ──────────────────────────────────────────────────

test.beforeAll(async () => {
  const appPath = path.resolve(__dirname, 'electron-entry.js')
  electronApp = await _electron.launch({
    args: [appPath, 'auto', '--auto-port', '0'],
    env: { ...process.env, NODE_ENV: 'test' },
  })

  mainWindow = await electronApp.firstWindow()
  await mainWindow.waitForLoadState('domcontentloaded')

  await electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isVisible()) {
      await new Promise<void>((resolve) => { win.once('show', resolve); setTimeout(resolve, 5000) })
    }
    if (win) { win.setPosition(-2000, -2000); win.blur() }
  })

  autoPort = await pollUntil(
    () => ipcInvoke<number | null>(mainWindow, AutomationChannel.GetPort),
    (val) => typeof val === 'number' && val > 0,
    10000,
    100,
  ) as number
})

test.afterAll(async () => {
  await electronApp?.close().catch(() => {})
})

// ── Tests ─────────────────────────────────────────────────────────────

test.describe('miniprogram-automator protocol compatibility', () => {
  test.setTimeout(120_000)
  test.describe.configure({ mode: 'serial' })

  test('WS server accepts connection and responds to Tool.getInfo', async () => {
    const result = await wsCall('Tool.getInfo')
    expect(result).toHaveProperty('SDKVersion')
    expect(result.SDKVersion).toBe('2.7.3')
  })

  test('unknown methods return error', async () => {
    await expect(wsCall('NonExistent.method')).rejects.toThrow('Unknown method')
  })

  // The following tests open a project first
  test.describe('with project open', () => {
    test.beforeAll(async () => {
      await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 8000, waitForWebview: true })
      await waitForSimulatorWebview(electronApp)
      await new Promise((r) => setTimeout(r, 2000))
    })

    test.afterAll(async () => {
      await closeProject(mainWindow).catch(() => {})
    })

    test('App.getPageStack returns stack', async () => {
      const result = await wsCall('App.getPageStack')
      const stack = result.pageStack as Array<{ pageId: number; path: string }>
      expect(stack.length).toBeGreaterThanOrEqual(1)
      expect(stack[stack.length - 1]!.path).toContain('index/index')
    })

    test.skip('Element.getDOMProperties reads innerText', async () => {
      const el = await wsCall('Page.getElement', { selector: '.page-title', pageId: 1 })
      const props = await wsCall('Element.getDOMProperties', {
        elementId: el.elementId,
        pageId: 1,
        names: ['innerText'],
      })
      const properties = props.properties as string[]
      expect(properties[0]).toContain('DevTools')
    })

    test.skip('Element.getWXML returns HTML content', async () => {
      const el = await wsCall('Page.getElement', { selector: '.page-title', pageId: 1 })
      const inner = await wsCall('Element.getWXML', { elementId: el.elementId, pageId: 1, type: 'inner' })
      expect(inner.wxml).toContain('DevTools')

      const outer = await wsCall('Element.getWXML', { elementId: el.elementId, pageId: 1, type: 'outer' })
      expect((outer.wxml as string)).toContain('page-title')
    })

    test('App.captureScreenshot returns PNG', async () => {
      const result = await wsCall('App.captureScreenshot')
      expect(result.data).toBeTruthy()
      const buf = Buffer.from(result.data as string, 'base64')
      expect(buf.length).toBeGreaterThan(100)
      expect(buf[0]).toBe(0x89) // PNG magic
    })

    test('App.callWxMethod works for storage', async () => {
      await wsCall('App.callWxMethod', {
        method: 'setStorageSync',
        args: ['compat_test_key', 'compat_test_value'],
      })

      const getResult = await wsCall('App.callWxMethod', {
        method: 'getStorageSync',
        args: ['compat_test_key'],
      })
      expect(getResult.result).toBe('compat_test_value')

      // Cleanup
      await wsCall('App.callWxMethod', {
        method: 'removeStorageSync',
        args: ['compat_test_key'],
      })
    })

    test('unsupported methods return descriptive errors', async () => {
      await expect(wsCall('Page.setData', { pageId: 1, data: {} }))
        .rejects.toThrow('not supported')

      await expect(wsCall('Page.callMethod', { pageId: 1, method: 'onLoad' }))
        .rejects.toThrow('not supported')

      await expect(wsCall('App.mockWxMethod', { method: 'test' }))
        .rejects.toThrow('not supported')
    })
  })
})

// ── npm miniprogram-automator package smoke tests ─────────────────────
//
// These tests use the real miniprogram-automator npm package (not our SDK
// wrapper) to verify that end-user automation scripts work against our
// devtools. They run in a separate Electron instance on a different port
// to keep them isolated from the protocol tests above.

test.describe('npm miniprogram-automator package', () => {
  test.setTimeout(120_000)
  test.describe.configure({ mode: 'serial' })

  let smokeElectronApp: ElectronApplication
  let smokeMainWindow: PwPage
  let smokePort: number
  let miniProgram: Awaited<ReturnType<typeof automator.connect>>

  test.beforeAll(async () => {
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    smokeElectronApp = await _electron.launch({
      args: [appPath, 'auto', '--auto-port', '0'],
      env: { ...process.env, NODE_ENV: 'test' },
    })

    smokeMainWindow = await smokeElectronApp.firstWindow()
    await smokeMainWindow.waitForLoadState('domcontentloaded')
    await smokeElectronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) { win.setPosition(-2000, -2000); win.blur() }
    })

    smokePort = await pollUntil(
      () => ipcInvoke<number | null>(smokeMainWindow, AutomationChannel.GetPort),
      (val) => typeof val === 'number' && val > 0,
      10000,
      100,
    ) as number

    await openProjectInUI(smokeMainWindow, DEMO_APP_DIR, { waitMs: 8000, waitForWebview: true })
    await waitForSimulatorWebview(smokeElectronApp)
    await new Promise((r) => setTimeout(r, 2000))

    miniProgram = await automator.connect({
      wsEndpoint: `ws://localhost:${smokePort}`,
    })
  })

  test.afterAll(async () => {
    if (miniProgram) {
      miniProgram.disconnect()
    }
    await closeProject(smokeMainWindow).catch(() => {})
    await smokeElectronApp?.close().catch(() => {})
  })

  test('automator.connect succeeds and currentPage returns index path', async () => {
    const page = await miniProgram.currentPage()
    expect(page.path).toContain('index/index')
  })

  test('callWxMethod round-trip works for storage', async () => {
    await miniProgram.callWxMethod('setStorageSync', 'auto_test_k', 'auto_test_v')

    const val = await miniProgram.callWxMethod('getStorageSync', 'auto_test_k')
    expect(val).toBe('auto_test_v')

    await miniProgram.callWxMethod('removeStorageSync', 'auto_test_k')
    const removed = await miniProgram.callWxMethod('getStorageSync', 'auto_test_k')
    expect(removed).toBe('')
  })
})
