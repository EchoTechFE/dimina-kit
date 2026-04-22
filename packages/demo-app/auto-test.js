/**
 * Demo 小程序自动化测试
 *
 * 使用 miniprogram-automator 连接已运行的开发者工具。
 *
 * 使用方式：
 *   1. 在开发者工具中打开 demo-app 项目（需启用自动化端口 9420）
 *   2. node auto-test.js
 */

const automator = require('miniprogram-automator')

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function main() {
  const port = process.env.AUTO_PORT || '9420'
  console.log(`🔌 连接开发者工具 ws://localhost:${port} ...`)

  let miniProgram
  try {
    miniProgram = await automator.connect({ wsEndpoint: `ws://localhost:${port}` })
  } catch (e) {
    console.error('❌ 连接失败，请确保开发者工具已启动并启用了自动化端口')
    console.error('   错误:', e.message)
    process.exit(1)
  }

  console.log('✅ 已连接\n')

  let passed = 0
  let failed = 0

  async function assert(name, fn) {
    try {
      await fn()
      passed++
      console.log(`  ✅ ${name}`)
    } catch (e) {
      failed++
      console.log(`  ❌ ${name}`)
      console.log(`     ${e.message}`)
    }
  }

  // ═══════════════════════════════════════════════════
  //  基本信息
  // ═══════════════════════════════════════════════════

  console.log('📋 基本信息')

  await assert('获取当前页面路径', async () => {
    const page = await miniProgram.currentPage()
    if (!page.path.includes('pages/')) throw new Error('path: ' + page.path)
    console.log(`     → ${page.path}`)
  })

  await assert('获取系统信息', async () => {
    const info = await miniProgram.systemInfo()
    if (!info.platform) throw new Error('缺少 platform 字段')
    console.log(`     → ${info.platform} ${info.screenWidth}x${info.screenHeight}`)
  })

  await assert('获取页面栈', async () => {
    const stack = await miniProgram.pageStack()
    if (stack.length < 1) throw new Error('页面栈为空')
    console.log(`     → 深度 ${stack.length}`)
  })

  // ═══════════════════════════════════════════════════
  //  首页元素查询
  // ═══════════════════════════════════════════════════

  console.log('\n🔍 首页元素查询')

  let page = await miniProgram.currentPage()

  await assert('查找页面标题 .page-title', async () => {
    const el = await page.$('.page-title')
    if (!el) throw new Error('未找到')
    const text = await el.text()
    if (!text.includes('DevTools')) throw new Error('标题: ' + text)
    console.log(`     → "${text}"`)
  })

  await assert('查找所有菜单项 .menu-item', async () => {
    const items = await page.$$('.menu-item')
    if (items.length !== 4) throw new Error('数量: ' + items.length)
    console.log(`     → ${items.length} 个菜单项`)
  })

  await assert('读取菜单项的 data-path 属性', async () => {
    const items = await page.$$('[data-path]')
    const paths = []
    for (const item of items) {
      paths.push(await item.attribute('data-path'))
    }
    console.log(`     → ${paths.join('\n       ')}`)
    if (!paths.includes('/pages/console-test/console-test'))
      throw new Error('缺少 console-test')
    if (!paths.includes('/pages/storage-test/storage-test'))
      throw new Error('缺少 storage-test')
    if (!paths.includes('/pages/network-test/network-test'))
      throw new Error('缺少 network-test')
    if (!paths.includes('/pages/component-test/component-test'))
      throw new Error('缺少 component-test')
  })

  await assert('获取元素 wxml', async () => {
    const el = await page.$('.page-desc')
    const inner = await el.wxml()
    if (!inner.includes('测试页面')) throw new Error('wxml 内容异常')
    const outer = await el.outerWxml()
    if (!outer.includes('page-desc')) throw new Error('outerWxml 缺少 class')
    console.log(`     → inner ${inner.length} chars, outer ${outer.length} chars`)
  })

  // ═══════════════════════════════════════════════════
  //  导航 — 点击菜单进入 Console 测试页
  // ═══════════════════════════════════════════════════

  console.log('\n👆 页面导航')

  await assert('点击 Console 测试菜单项', async () => {
    const item = await page.$('[data-path="/pages/console-test/console-test"]')
    if (!item) throw new Error('未找到菜单项')
    await item.tap()
    await sleep(3000)
    const cur = await miniProgram.currentPage()
    if (!cur.path.includes('console-test'))
      throw new Error('导航失败, 当前: ' + cur.path)
    console.log(`     → 成功导航到 ${cur.path}`)
  })

  await assert('页面栈深度增加', async () => {
    const stack = await miniProgram.pageStack()
    if (stack.length < 2) throw new Error('栈深度: ' + stack.length)
    console.log(`     → 栈深度 ${stack.length}`)
  })

  // ═══════════════════════════════════════════════════
  //  Console 页面元素检查
  // ═══════════════════════════════════════════════════

  console.log('\n📄 Console 测试页')

  page = await miniProgram.currentPage()

  await assert('Console 页有按钮', async () => {
    const buttons = await page.$$('[bindtap]')
    if (buttons.length === 0) throw new Error('没有可点击的按钮')
    console.log(`     → ${buttons.length} 个可交互元素`)
  })

  // ═══════════════════════════════════════════════════
  //  wx Storage API
  // ═══════════════════════════════════════════════════

  console.log('\n📦 wx.Storage API')

  await assert('setStorageSync + getStorageSync', async () => {
    await miniProgram.callWxMethod('setStorageSync', 'test_name', '张三')
    const val = await miniProgram.callWxMethod('getStorageSync', 'test_name')
    if (val !== '张三') throw new Error('读取值: ' + val)
    console.log(`     → 写入 "张三", 读回 "${val}"`)
  })

  await assert('removeStorageSync', async () => {
    await miniProgram.callWxMethod('removeStorageSync', 'test_name')
    const val = await miniProgram.callWxMethod('getStorageSync', 'test_name')
    if (val !== '') throw new Error('删除后仍有值: ' + val)
    console.log(`     → 删除成功`)
  })

  // ═══════════════════════════════════════════════════
  //  evaluate 代码注入
  // ═══════════════════════════════════════════════════

  console.log('\n💉 evaluate 代码执行')

  await assert('执行简单运算', async () => {
    const r = await miniProgram.evaluate(() => 100 * 2 + 20)
    if (r !== 220) throw new Error('结果: ' + r)
  })

  await assert('访问 wx 对象', async () => {
    const r = await miniProgram.evaluate(() => typeof wx)
    if (r !== 'object') throw new Error('typeof wx: ' + r)
  })

  await assert('读取 location.hash', async () => {
    const r = await miniProgram.evaluate(() => location.hash)
    if (!r.includes('console-test')) throw new Error('hash: ' + r)
    console.log(`     → ${r}`)
  })

  // ═══════════════════════════════════════════════════
  //  截图
  // ═══════════════════════════════════════════════════

  console.log('\n📸 截图')

  await assert('screenshot 返回图片数据', async () => {
    const data = await miniProgram.screenshot()
    if (!data || data.length < 100) throw new Error('数据太小')
    const kb = Math.round(data.length / 1024)
    console.log(`     → ${kb} KB (base64)`)
  })

  // ═══════════════════════════════════════════════════
  //  报告
  // ═══════════════════════════════════════════════════

  console.log('\n' + '═'.repeat(50))
  console.log(`  📊 测试结果: ${passed + failed} 个用例`)
  console.log(`     ✅ 通过: ${passed}`)
  if (failed > 0) console.log(`     ❌ 失败: ${failed}`)
  console.log('═'.repeat(50))

  miniProgram.disconnect()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('💥 测试异常:', err.message)
  process.exit(1)
})
