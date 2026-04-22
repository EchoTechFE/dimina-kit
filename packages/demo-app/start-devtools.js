/**
 * 启动开发者工具并打开 demo 项目，启用自动化端口。
 * 用法: node start-devtools.js
 * 然后在另一个终端运行: node auto-test.js
 */

import { _electron } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEMO_APP_DIR = __dirname
const AUTO_PORT = 9420

async function main() {
  const entryPath = path.resolve(__dirname, '..', 'dimina-devtools', 'e2e', 'electron-entry.js')
  if (!fs.existsSync(entryPath)) {
    console.error('❌ 找不到 electron-entry.js，请先 build: pnpm --filter dimina-devtools build')
    process.exit(1)
  }

  console.log(`🚀 启动开发者工具 (自动化端口: ${AUTO_PORT})...`)
  const electronApp = await _electron.launch({
    args: [entryPath, 'auto', '--auto-port', String(AUTO_PORT)],
    env: { ...process.env, NODE_ENV: 'test' },
  })

  const mainWindow = await electronApp.firstWindow()
  await mainWindow.waitForLoadState('domcontentloaded')

  // 打开 demo 项目
  console.log(`📂 打开项目: ${DEMO_APP_DIR}`)
  await mainWindow.evaluate(
    async ({ channel, args }) => {
      const { ipcRenderer } = window.require('electron')
      return ipcRenderer.invoke(channel, ...args)
    },
    { channel: 'projects:add', args: [DEMO_APP_DIR] },
  )
  await mainWindow.evaluate(() => {
    const { ipcRenderer } = window.require('electron')
    ipcRenderer.emit('window:navigateBack', {})
  })

  const projectPathLabel = mainWindow.locator(`[title="${DEMO_APP_DIR}"]`).first()
  await projectPathLabel.waitFor()
  await projectPathLabel.locator('..').click()
  await mainWindow.waitForSelector('text=普通编译')

  console.log('⏳ 等待编译完成...')
  await mainWindow.waitForTimeout(8000)

  console.log(`✅ 开发者工具已启动，自动化端口: ws://localhost:${AUTO_PORT}`)
  console.log('   现在可以在另一个终端运行: node auto-test.js')
  console.log('   按 Ctrl+C 关闭')

  // 保持运行
  await new Promise(() => {})
}

main().catch(err => {
  console.error('❌', err.message)
  process.exit(1)
})
