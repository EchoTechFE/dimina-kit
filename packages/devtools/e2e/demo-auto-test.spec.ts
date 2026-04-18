/**
 * Real-world automation test using miniprogram-automator npm package
 * to drive the demo-app through dimina-devtools.
 *
 * This is what end users would write — a standard miniprogram-automator
 * test script that works identically on WeChat devtools and dimina devtools.
 */

import { test, expect, _electron } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  DEMO_APP_DIR,
  openProjectInUI,
  waitForSimulatorWebview,
  closeProject,
} from './helpers'

import { createRequire } from 'module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTO_PORT = 9422

// miniprogram-automator is CJS, need createRequire in ESM context
const require = createRequire(import.meta.url)
const automator = require('miniprogram-automator')

test.describe('Demo App — miniprogram-automator 自动化测试', () => {
  test.setTimeout(120_000)

  let electronApp: Awaited<ReturnType<typeof _electron.launch>>
  let mainWindow: Awaited<ReturnType<typeof electronApp.firstWindow>>
  let miniProgram: Awaited<ReturnType<typeof automator.connect>>

  test.beforeAll(async () => {
    // 1. Launch devtools with --auto flag
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    electronApp = await _electron.launch({
      args: [appPath, 'auto', '--auto-port', String(AUTO_PORT)],
      env: { ...process.env, NODE_ENV: 'test' },
    })

    mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) { win.setPosition(-2000, -2000); win.blur() }
    })

    // 2. Open the demo project
    await openProjectInUI(mainWindow, DEMO_APP_DIR, { waitMs: 8000, waitForWebview: true })
    await waitForSimulatorWebview(electronApp)
    await new Promise((r) => setTimeout(r, 2000))

    // 3. Connect miniprogram-automator
    miniProgram = await automator.connect({
      wsEndpoint: `ws://localhost:${AUTO_PORT}`,
    })
  })

  test.afterAll(async () => {
    if (miniProgram) {
      miniProgram.disconnect()
    }
    await closeProject(mainWindow).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  // ── 基础能力 ──────────────────────────────────────────────────────

  test('currentPage 返回首页路径', async () => {
    const page = await miniProgram.currentPage()
    expect(page.path).toContain('index/index')
  })

  test('systemInfo 获取设备信息', async () => {
    const info = await miniProgram.systemInfo()
    expect(info).toHaveProperty('platform')
    expect(info).toHaveProperty('screenWidth')
    expect(info).toHaveProperty('screenHeight')
  })

  test('screenshot 截图', async () => {
    const base64 = await miniProgram.screenshot()
    expect(base64.length).toBeGreaterThan(100)
  })

  // ── 元素查询 ──────────────────────────────────────────────────────

  test('$() 查找页面标题', async () => {
    const page = await miniProgram.currentPage()
    const title = await page.$('.page-title')
    expect(title).not.toBeNull()
    expect(title.tagName).toBe('div')
    const text = await title.text()
    expect(text).toContain('DevTools')
  })

  test('$$() 查找所有菜单项', async () => {
    const page = await miniProgram.currentPage()
    const items = await page.$$('.menu-item')
    expect(items.length).toBe(4)
  })

  test('element.attribute() 读取属性', async () => {
    const page = await miniProgram.currentPage()
    const items = await page.$$('[data-path]')
    expect(items.length).toBe(4)

    const firstPath = await items[0].attribute('data-path')
    expect(firstPath).toContain('/pages/')
  })

  test('element.wxml() 获取元素 HTML', async () => {
    const page = await miniProgram.currentPage()
    const title = await page.$('.page-title')
    const wxml = await title.wxml()
    expect(wxml).toContain('DevTools')
  })

  test('element.outerWxml() 获取含自身的 HTML', async () => {
    const page = await miniProgram.currentPage()
    const title = await page.$('.page-title')
    const outer = await title.outerWxml()
    expect(outer).toContain('page-title')
    expect(outer).toContain('DevTools')
  })

  // ── 元素交互 ──────────────────────────────────────────────────────

  test('tap() 点击菜单项导航到 Console 页', async () => {
    const page = await miniProgram.currentPage()
    const consoleItem = await page.$('[data-path="/pages/console-test/console-test"]')
    expect(consoleItem).not.toBeNull()

    await consoleItem.tap()
    await new Promise((r) => setTimeout(r, 3000))

    const currentPage = await miniProgram.currentPage()
    expect(currentPage.path).toContain('console-test')
  })

  // ── wx API 调用 ───────────────────────────────────────────────────

  test('callWxMethod 操作 storage', async () => {
    // 写入
    await miniProgram.callWxMethod('setStorageSync', 'auto_test_k', 'auto_test_v')

    // 读取
    const val = await miniProgram.callWxMethod('getStorageSync', 'auto_test_k')
    expect(val).toBe('auto_test_v')

    // 删除
    await miniProgram.callWxMethod('removeStorageSync', 'auto_test_k')
    const removed = await miniProgram.callWxMethod('getStorageSync', 'auto_test_k')
    expect(removed).toBe('')
  })

  // ── evaluate 代码注入 ─────────────────────────────────────────────

  test('evaluate 在模拟器执行 JS', async () => {
    const result = await miniProgram.evaluate(() => {
      return 1 + 2 + 3
    })
    expect(result).toBe(6)
  })

  test('evaluate 访问 wx 对象', async () => {
    const result = await miniProgram.evaluate(() => {
      return typeof wx === 'object'
    })
    expect(result).toBe(true)
  })

  // ── pageStack ─────────────────────────────────────────────────────

  test('pageStack 返回页面栈', async () => {
    const stack = await miniProgram.pageStack()
    expect(stack.length).toBeGreaterThanOrEqual(1)
  })
})
