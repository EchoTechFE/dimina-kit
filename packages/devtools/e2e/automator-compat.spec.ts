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
import {
  DEMO_APP_DIR,
  openProjectInUI,
  waitForSimulatorWebview,
  evalInSimulator,
  closeProject,
} from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTO_PORT = 9421 // Use non-default port to avoid conflicts

// ── Shared state ──────────────────────────────────────────────────────

let electronApp: ElectronApplication
let mainWindow: PwPage

// ── WS helper ─────────────────────────────────────────────────────────

function wsCall(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${AUTO_PORT}`)
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
    args: [appPath, 'auto', '--auto-port', String(AUTO_PORT)],
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

  // Wait for WS server to start
  await new Promise((r) => setTimeout(r, 2000))
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

    test('App.getCurrentPage returns page path', async () => {
      const result = await wsCall('App.getCurrentPage')
      expect(result.path).toContain('index/index')
      expect(result).toHaveProperty('pageId')
      expect(result).toHaveProperty('query')
    })

    test('App.getPageStack returns stack', async () => {
      const result = await wsCall('App.getPageStack')
      const stack = result.pageStack as Array<{ pageId: number; path: string }>
      expect(stack.length).toBeGreaterThanOrEqual(1)
      expect(stack[stack.length - 1]!.path).toContain('index/index')
    })

    test('Page.getElements finds DOM elements', async () => {
      const result = await wsCall('Page.getElements', { selector: '.menu-item', pageId: 1 })
      const elements = result.elements as Array<{ elementId: string; tagName: string }>
      expect(elements.length).toBe(4)
      expect(elements[0]!.elementId).toBeTruthy()
      expect(elements[0]!.tagName).toBe('div')
    })

    test('Page.getElement finds a single element', async () => {
      const result = await wsCall('Page.getElement', { selector: '.page-title', pageId: 1 })
      expect(result.elementId).toBeTruthy()
      expect(result.tagName).toBe('div')
    })

    test('Element.getDOMProperties reads innerText', async () => {
      const el = await wsCall('Page.getElement', { selector: '.page-title', pageId: 1 })
      const props = await wsCall('Element.getDOMProperties', {
        elementId: el.elementId,
        pageId: 1,
        names: ['innerText'],
      })
      const properties = props.properties as string[]
      expect(properties[0]).toContain('DevTools')
    })

    test('Element.getAttributes reads data-path', async () => {
      const el = await wsCall('Page.getElement', {
        selector: '[data-path="/pages/console-test/console-test"]',
        pageId: 1,
      })
      const attrs = await wsCall('Element.getAttributes', {
        elementId: el.elementId,
        pageId: 1,
        names: ['data-path', 'bindtap'],
      })
      const attributes = attrs.attributes as string[]
      expect(attributes[0]).toBe('/pages/console-test/console-test')
      expect(attributes[1]).toBe('navigateTo')
    })

    test('Element.getWXML returns HTML content', async () => {
      const el = await wsCall('Page.getElement', { selector: '.page-title', pageId: 1 })
      const inner = await wsCall('Element.getWXML', { elementId: el.elementId, pageId: 1, type: 'inner' })
      expect(inner.wxml).toContain('DevTools')

      const outer = await wsCall('Element.getWXML', { elementId: el.elementId, pageId: 1, type: 'outer' })
      expect((outer.wxml as string)).toContain('page-title')
    })

    test('Element.tap triggers navigation', async () => {
      const el = await wsCall('Page.getElement', {
        selector: '[data-path="/pages/console-test/console-test"]',
        pageId: 1,
      })
      await wsCall('Element.tap', { elementId: el.elementId, pageId: 1 })
      await new Promise((r) => setTimeout(r, 3000))

      const hash = await evalInSimulator<string>(electronApp, 'location.hash')
      expect(hash).toContain('console-test')
    })

    test('App.getCurrentPage reflects navigation', async () => {
      // After tap navigation in previous test
      const result = await wsCall('App.getCurrentPage')
      expect(result.path).toContain('console-test')
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

    test('App.callWxMethod works for getSystemInfoSync', async () => {
      const result = await wsCall('App.callWxMethod', {
        method: 'getSystemInfoSync',
        args: [],
      })
      const info = result.result as Record<string, unknown>
      expect(info).toHaveProperty('platform')
      expect(info).toHaveProperty('screenWidth')
    })

    test('App.callFunction evaluates JS in simulator', async () => {
      const result = await wsCall('App.callFunction', {
        functionDeclaration: '() => 1 + 2 + 3',
        args: [],
      })
      expect(result.result).toBe(6)
    })

    test('Page.getData returns appdata', async () => {
      const result = await wsCall('Page.getData', { pageId: 1 })
      // AppData may or may not have data depending on timing
      expect(result).toHaveProperty('data')
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
