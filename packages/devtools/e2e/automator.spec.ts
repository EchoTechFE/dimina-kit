/**
 * Automated tests for the demo-app using the dimina-automator SDK.
 *
 * This mirrors how miniprogram-automator is used:
 *   Automator.launch() → MiniProgram → Page → Element
 *
 * Tests cover: launch, navigation, $/$$/element queries, wx APIs, evaluate,
 * waitForSelector, screenshot. They depend on the dimina simulator runtime
 * loading container assets (container-api.js / container.css) from
 * /assets/* served by devkit. If those assets are missing the simulator
 * never renders mini-program DOM and every element-query test will fail —
 * make sure `pnpm build:container` has been run.
 */

import { test as base, expect } from '@playwright/test'
import { Automator, MiniProgram } from './automator'
import { DEMO_APP_DIR } from './helpers'

const test = base.extend<{ miniProgram: MiniProgram }>({
  // eslint-disable-next-line no-empty-pattern
  miniProgram: async ({}, use, testInfo) => {
    const mp = await Automator.launch({
      projectPath: DEMO_APP_DIR,
      compileWaitMs: 10000,
      waitForWebview: true,
      workerIndex: testInfo.workerIndex,
    })
    await use(mp)
    await mp.close()
  },
})

test.describe('dimina-automator SDK', () => {
  test.setTimeout(120_000)
  test.describe.configure({ retries: 1 })

  // ── Launch & Page Route ───────────────────────────────────────────

  test('launch loads the index page', async ({ miniProgram }) => {
    const pagePath = await miniProgram.currentPagePath()
    expect(pagePath).toContain('index/index')
  })

  test('currentPage returns a Page with correct path', async ({ miniProgram }) => {
    const page = await miniProgram.currentPage()
    expect(page.path).toContain('index/index')
  })

  // ── Navigation ────────────────────────────────────────────────────

  test('navigateTo changes the page route via hash', async ({ miniProgram }) => {
    const page = await miniProgram.navigateTo('pages/console-test/console-test')
    expect(page.path).toContain('console-test')
  })

  test('clicking a menu item navigates to the target page', async ({ miniProgram }) => {
    await miniProgram.navigateTo('pages/index/index')
    const page = await miniProgram.currentPage()
    await miniProgram.waitFor(1000)

    // Find the first menu item and click it
    const menuItem = await page.$('[bindtap="navigateTo"]')
    expect(menuItem).not.toBeNull()

    const dataPath = await menuItem!.attribute('data-path')
    expect(dataPath).toContain('console-test')

    await menuItem!.tap()
    await miniProgram.waitFor(2000)

    const newPath = await miniProgram.currentPagePath()
    expect(newPath).toContain('console-test')

    // Navigate back to index for other tests
    await miniProgram.navigateTo('pages/index/index')
  })

  // ── Element Queries ───────────────────────────────────────────────

  test('$ finds a single element', async ({ miniProgram }) => {
    await miniProgram.navigateTo('pages/index/index')
    const page = await miniProgram.currentPage()
    await miniProgram.waitFor(1000)

    const title = await page.$('.page-title')
    expect(title).not.toBeNull()

    const text = await title!.text()
    expect(text).toContain('DevTools')
  })

  test('$$ finds multiple elements', async ({ miniProgram }) => {
    await miniProgram.navigateTo('pages/index/index')
    const page = await miniProgram.currentPage()
    await miniProgram.waitFor(1000)

    const menuItems = await page.$$('.menu-item')
    expect(menuItems.length).toBe(5) // demo pages: console / storage / network / component / swiper
  })

  test('element text() returns visible text', async ({ miniProgram }) => {
    await miniProgram.navigateTo('pages/index/index')
    const page = await miniProgram.currentPage()
    await miniProgram.waitFor(1000)

    const desc = await page.$('.page-desc')
    expect(desc).not.toBeNull()
    const text = await desc!.text()
    expect(text).toContain('测试页面')
  })

  test('element attribute() reads HTML attributes', async ({ miniProgram }) => {
    await miniProgram.navigateTo('pages/index/index')
    const page = await miniProgram.currentPage()
    await miniProgram.waitFor(1000)

    const items = await page.$$('[bindtap="navigateTo"]')
    expect(items.length).toBe(5)

    // Check data-path attributes
    const paths: string[] = []
    for (const item of items) {
      const p = await item.attribute('data-path')
      if (p) paths.push(p)
    }
    expect(paths).toContain('/pages/console-test/console-test')
    expect(paths).toContain('/pages/storage-test/storage-test')
    expect(paths).toContain('/pages/network-test/network-test')
    expect(paths).toContain('/pages/component-test/component-test')
  })

  test('element tagName() returns the tag', async ({ miniProgram }) => {
    await miniProgram.navigateTo('pages/index/index')
    const page = await miniProgram.currentPage()
    await miniProgram.waitFor(1000)

    const el = await page.$('.container')
    expect(el).not.toBeNull()
    const tag = await el!.tagName()
    expect(tag).toBe('div')
  })

  test('element exists() checks presence', async ({ miniProgram }) => {
    await miniProgram.navigateTo('pages/index/index')
    const page = await miniProgram.currentPage()
    await miniProgram.waitFor(1000)

    const el = await page.$('.container')
    expect(await el!.exists()).toBe(true)

    const missing = await page.$('.nonexistent-element')
    expect(missing).toBeNull()
  })

  test('element classList() returns CSS classes', async ({ miniProgram }) => {
    await miniProgram.navigateTo('pages/index/index')
    const page = await miniProgram.currentPage()
    await miniProgram.waitFor(1000)

    const el = await page.$('.container')
    const classes = await el!.classList()
    expect(classes).toContain('container')
    expect(classes).toContain('dd-page')
    expect(classes).toContain('dd-view')
  })

  test('element dataAttributes() reads data-* attrs', async ({ miniProgram }) => {
    await miniProgram.navigateTo('pages/index/index')
    const page = await miniProgram.currentPage()
    await miniProgram.waitFor(1000)

    const menuItem = await page.$('[bindtap="navigateTo"]')
    const data = await menuItem!.dataAttributes()
    expect(data).toHaveProperty('path')
    expect(data.path).toContain('/pages/')
  })

  // ── Child Element Queries ─────────────────────────────────────────

  test('element.$() finds child elements', async ({ miniProgram }) => {
    await miniProgram.navigateTo('pages/index/index')
    const page = await miniProgram.currentPage()
    await miniProgram.waitFor(1000)

    const section = await page.$('.section')
    expect(section).not.toBeNull()

    const title = await section!.$('.menu-title')
    expect(title).not.toBeNull()
    const text = await title!.text()
    expect(text).toContain('Console')
  })

  test('element.$$() finds multiple children', async ({ miniProgram }) => {
    await miniProgram.navigateTo('pages/index/index')
    const page = await miniProgram.currentPage()
    await miniProgram.waitFor(1000)

    const firstSection = await page.$('.section')
    const tags = await firstSection!.$$('.tag')
    expect(tags.length).toBeGreaterThanOrEqual(1)
  })

  // ── Component Test Page ───────────────────────────────────────────

  test('component-test page renders dynamic content', async ({ miniProgram }) => {
    await miniProgram.navigateTo('pages/component-test/component-test')
    const page = await miniProgram.currentPage()
    // Wait for the component-test page to render with its section title
    await page.waitForSelector('.section-title')
    await miniProgram.waitFor(500)

    // Find section title that contains component test text
    const sectionTitles = await page.$$('.section-title')
    expect(sectionTitles.length).toBeGreaterThan(0)
    const firstTitle = await sectionTitles[0].text()
    expect(firstTitle).toContain('setData')

    // Check that buttons exist (dimina transforms <button> to elements with btn class)
    const buttons = await page.$$('[bindtap]')
    expect(buttons.length).toBeGreaterThan(0)
  })

  test('component-test: tap button triggers DOM update', async ({ miniProgram }) => {
    await miniProgram.navigateTo('pages/component-test/component-test')
    const page = await miniProgram.currentPage()
    await page.waitForSelector('[bindtap="incrementCount"]')
    await miniProgram.waitFor(500)

    // Find the increment button
    const incrementBtn = await page.$('[bindtap="incrementCount"]')
    expect(incrementBtn).not.toBeNull()

    // Get displayed count text before
    const getCountText = async () => {
      const el = await page.$('[bindtap="incrementCount"]')
      return el ? await el.text() : ''
    }
    const textBefore = await getCountText()

    // Tap the button
    await incrementBtn!.tap()
    await miniProgram.waitFor(1500)

    // Count should have changed
    const textAfter = await getCountText()
    expect(textAfter).not.toBe(textBefore)
  })

  // ── Storage Page ──────────────────────────────────────────────────

  test('storage-test page renders', async ({ miniProgram }) => {
    await miniProgram.navigateTo('pages/storage-test/storage-test')
    const page = await miniProgram.currentPage()
    await miniProgram.waitFor(1500)

    const title = await page.$('.page-title')
    expect(title).not.toBeNull()
  })

  // ── wx API Calls ──────────────────────────────────────────────────

  test('wx.getSystemInfoSync returns device info', async ({ miniProgram }) => {
    const info = await miniProgram.getSystemInfo()
    expect(info).toHaveProperty('platform')
    expect(info).toHaveProperty('screenWidth')
    expect(info).toHaveProperty('screenHeight')
  })

  test('wx storage APIs work (set/get/remove)', async ({ miniProgram }) => {
    // Set
    await miniProgram.setStorage('automator_test_key', 'automator_test_value')

    // Get
    const value = await miniProgram.getStorage('automator_test_key')
    expect(value).toBe('automator_test_value')

    // Remove
    await miniProgram.removeStorage('automator_test_key')
    const removed = await miniProgram.getStorage('automator_test_key')
    expect(removed).toBe('')
  })

  // ── Evaluate JS ───────────────────────────────────────────────────

  test('evaluate runs JS in simulator top window', async ({ miniProgram }) => {
    const result = await miniProgram.evaluate<number>('1 + 2 + 3')
    expect(result).toBe(6)
  })

  test('evaluate can access wx object', async ({ miniProgram }) => {
    const hasWx = await miniProgram.evaluate<boolean>('typeof wx === "object"')
    expect(hasWx).toBe(true)
  })

  test('evaluateInPage runs JS in page iframe', async ({ miniProgram }) => {
    await miniProgram.navigateTo('pages/index/index')
    await miniProgram.waitFor(1000)

    // evaluateInPage provides _doc (iframe contentDocument) and _win (iframe contentWindow)
    const bodyExists = await miniProgram.evaluateInPage<boolean>('!!_doc.body')
    expect(bodyExists).toBe(true)

    const hasContainer = await miniProgram.evaluateInPage<boolean>(
      "_doc.querySelector('.container') !== null",
    )
    expect(hasContainer).toBe(true)
  })

  // ── waitForSelector ───────────────────────────────────────────────

  test('waitForSelector waits for element to appear', async ({ miniProgram }) => {
    await miniProgram.navigateTo('pages/index/index')
    const page = await miniProgram.currentPage()

    const el = await page.waitForSelector('.container')
    expect(el).toBeTruthy()
    const exists = await el.exists()
    expect(exists).toBe(true)
  })

  // ── Screenshot ────────────────────────────────────────────────────

  test('screenshot returns a PNG buffer', async ({ miniProgram }) => {
    const buf = await miniProgram.screenshot()
    expect(buf).toBeInstanceOf(Buffer)
    expect(buf.length).toBeGreaterThan(100)
    // PNG magic bytes
    expect(buf[0]).toBe(0x89)
    expect(buf[1]).toBe(0x50)
    expect(buf[2]).toBe(0x4e)
    expect(buf[3]).toBe(0x47)
  })

  // ── Page bodyHTML ─────────────────────────────────────────────────

  test('page bodyHTML returns rendered content', async ({ miniProgram }) => {
    await miniProgram.navigateTo('pages/index/index')
    const page = await miniProgram.currentPage()
    await miniProgram.waitFor(1000)

    const html = await page.bodyHTML()
    expect(html).toContain('DevTools')
    expect(html).toContain('menu-item')
  })
})
