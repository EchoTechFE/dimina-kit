/**
 * E2E (native-host): label 激活控件的语义，用真实输入事件验证。
 *
 * 这里必须走 `webContents.sendInputEvent`，而不是 `element.dispatchEvent`：
 * 被验证的行为恰恰依赖浏览器自己的输入管线——真实指针序列补发的 click 带非零
 * 点击计数，而原生 <label> 把 click 转发给内部的真实 input 是浏览器的默认行为。
 * 合成事件两者都产生不了，验不出这里的任何一条。
 *
 * 契约（与微信开发者工具实测一致）：
 *   - 一次交互在路径上的每个节点恰好一次 tap；
 *   - 被 label 激活的控件执行自己的动作（change）但不派发自己的 tap；
 *   - for= 远程激活不波及远程控件，也不波及它的祖先；
 *   - label 内嵌原生输入框时，点文字聚焦输入框且不产生第二次 tap。
 */
import { test, expect, _electron, type ElectronApplication, type Page as PwPage } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  openProject, waitForSimulatorWebview, closeProject, pollUntil,
  evalInSimulator, getCurrentPage, getPageData, RENDER_GUEST_URL_MARKER,
} from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'label-app')
const APP_ID = 'devtools_label_fixture'
const ENTRY_ROUTE = 'pages/index/index'

let electronApp: ElectronApplication
let mainWindow: PwPage

interface Rect { x: number, y: number, width: number, height: number }
type Counts = Record<string, number>

/** bridgeId of the currently visible render `<webview>` in the device shell. */
async function visibleBridgeId(): Promise<string | null> {
  return evalInSimulator<string | null>(electronApp, `(() => {
    const wvs = Array.from(document.querySelectorAll('.device-shell__webview'));
    const visible = wvs.find((w) => getComputedStyle(w).display !== 'none');
    if (!visible) return null;
    const m = (visible.getAttribute('src') || '').match(/[?&]bridgeId=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  })()`).catch(() => null)
}

/**
 * Evaluate inside the RENDER guest of `bridgeId`.
 *
 * The bridge's service host and render host URLs both carry `bridgeId=`, so
 * matching on that alone can land in the service document (empty body) —
 * the render-host document name is what disambiguates them.
 */
async function guestEval(expression: string): Promise<string> {
  const bridgeId = await visibleBridgeId()
  if (!bridgeId) return 'null'
  return electronApp.evaluate(async ({ webContents }, payload) => {
    const target = webContents.getAllWebContents().find(
      (wc) => wc.getURL().includes('bridgeId=' + payload.bridgeId)
        && wc.getURL().includes(payload.marker),
    )
    if (!target) throw new Error('render guest webContents not found')
    return target.executeJavaScript(payload.expression) as Promise<string>
  }, { bridgeId, marker: RENDER_GUEST_URL_MARKER, expression }).catch(() => 'null')
}

/** A selector's rect inside the visible render guest (guest-local coordinates). */
async function guestRect(selector: string): Promise<Rect | null> {
  const json = await guestEval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'null';
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height });
  })()`)
  return JSON.parse(json) as Rect | null
}

/** Real click at guest-local (x, y), dispatched on the render guest itself. */
async function realClickInGuest(bridgeId: string, x: number, y: number): Promise<void> {
  await electronApp.evaluate(async ({ webContents }, pt) => {
    const target = webContents.getAllWebContents().find(
      (wc) => wc.getURL().includes('bridgeId=' + pt.bridgeId) && wc.getURL().includes(pt.marker),
    )
    if (!target) throw new Error('render guest webContents not found')
    const base = { x: pt.x, y: pt.y, button: 'left' as const, clickCount: 1 }
    target.sendInputEvent({ ...base, type: 'mouseMove' })
    target.sendInputEvent({ ...base, type: 'mouseDown' })
    await new Promise((r) => setTimeout(r, 40))
    target.sendInputEvent({ ...base, type: 'mouseUp' })
  }, { bridgeId, x, y, marker: RENDER_GUEST_URL_MARKER })
}

async function realClickInPage(selector: string): Promise<void> {
  const bridgeId = await visibleBridgeId()
  const rect = await guestRect(selector)
  if (!bridgeId) throw new Error('no visible page webview')
  if (!rect) throw new Error(`selector not found in page guest: ${selector}`)
  // sendInputEvent 打的是真实坐标，落在视口外的元素点不到，而症状只是计数不动——
  // 那会被读成"这次交互没产生事件"，正好是本文件里几条断言要区分的东西。
  const viewport = await guestEval(`(() => window.innerHeight + 'x' + window.innerWidth)()`)
  const [height, width] = String(viewport).split('x').map(Number)
  if (rect.y + rect.height > height || rect.x + rect.width > width || rect.y < 0 || rect.x < 0) {
    throw new Error(
      `${selector} 不在设备视口内（元素 ${JSON.stringify(rect)}，视口 ${width}x${height}）：`
      + '缩紧 fixture 排版，别让用例掉到折叠线以下',
    )
  }
  await realClickInGuest(
    bridgeId,
    Math.round(rect.x + rect.width / 2),
    Math.round(rect.y + rect.height / 2),
  )
}

async function readCounts(): Promise<Counts> {
  // getPageData 的第三个参数是数据路径，不是页面路由：省略它取整个页面 data。
  const data = await getPageData(electronApp, APP_ID) as { counts?: Counts } | null
  return data?.counts ?? {}
}

function delta(before: Counts, after: Counts, key: string): number {
  return (after[key] ?? 0) - (before[key] ?? 0)
}

/**
 * 点一次，等到期望的计数键先出现，再多等一轮让迟到的事件也落地。
 * 断言"某个键为 0"必须建立在"该轮已经确实发生过事情"之上，否则测的是等待不够。
 */
async function clickAndSettle(selector: string, expectKey: string): Promise<{ before: Counts, after: Counts }> {
  const before = await readCounts()
  await realClickInPage(selector)
  await pollUntil(
    () => readCounts().catch(() => ({} as Counts)),
    (counts) => delta(before, counts, expectKey) >= 1,
    10000,
    200,
  )
  await new Promise((r) => setTimeout(r, 800))
  return { before, after: await readCounts() }
}

/** 输入框是否处于聚焦状态（在 render guest 里读真实 activeElement）。 */
async function focusedTagInGuest(): Promise<string> {
  return guestEval(`(() => (document.activeElement && document.activeElement.tagName) || '')()`)
}

test.describe('native-host: label activation semantics under real input events', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    const appPath = path.resolve(__dirname, 'electron-entry.js')
    const userDataDir = path.resolve(
      process.env.DIMINA_DEVTOOLS_DATA_DIR
        ?? path.resolve(__dirname, '..', 'node_modules', '.cache', 'electron-runtime-e2e'),
      'userdata',
      `nh-label-${process.pid}`,
    )
    fs.mkdirSync(userDataDir, { recursive: true })
    electronApp = await _electron.launch({
      args: [appPath, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, NODE_ENV: 'test', DIMINA_E2E_USER_DATA_DIR: userDataDir },
    })
    mainWindow = await electronApp.firstWindow()
    await mainWindow.waitForLoadState('domcontentloaded')
    // sendInputEvent 需要 widget 完成布局，所以窗口保持在屏幕上，只取消聚焦。
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isVisible()) {
        await new Promise<void>((r) => { win.once('show', r); setTimeout(r, 5000) })
      }
      if (win) win.blur()
    })
    await openProject(electronApp, FIXTURE_DIR)
    await waitForSimulatorWebview(electronApp)
    await pollUntil(
      () => evalInSimulator<number>(
        electronApp,
        `(() => document.querySelectorAll('.device-shell__webview').length)()`,
      ).catch(() => 0),
      (n) => n >= 1,
      30000,
      400,
    )
    await pollUntil(
      () => getCurrentPage(electronApp).catch(() => null),
      (r) => !!r && typeof r.path === 'string' && r.path.includes(ENTRY_ROUTE),
      15000,
      300,
    )
    await pollUntil(
      () => guestRect('.lab-txt-a').catch(() => null),
      (r) => !!r && r.width > 0 && r.height > 0,
      20000,
      400,
    )
  })

  test.afterAll(async () => {
    await closeProject(electronApp).catch(() => {})
    await electronApp?.close().catch(() => {})
  })

  test('CONTROL: a real click on a plain text emits exactly one tap on it and one on its ancestor', async () => {
    const { before, after } = await clickAndSettle('.hit-a', 'textA.tap')
    expect(delta(before, after, 'textA.tap'), 'text 自己的 tap').toBe(1)
    expect(delta(before, after, 'viewA.tap'), '祖先 view 的 tap').toBe(1)
  })

  test('tapping label text emits one tap on the label and one on its ancestor', async () => {
    const { before, after } = await clickAndSettle('.lab-txt-a', 'labelA.tap')
    expect(delta(before, after, 'labelA.tap'), 'label 自己的 tap').toBe(1)
    expect(delta(before, after, 'viewA.tap'), '祖先 view 的 tap').toBe(1)
  })

  test('the activated control changes without emitting its own tap', async () => {
    const { before, after } = await clickAndSettle('.lab-txt-a', 'switchA.change')
    expect(delta(before, after, 'switchA.change'), '控件被激活').toBe(1)
    expect(delta(before, after, 'switchA.tap'), '被激活的控件不派发自己的 tap').toBe(0)
  })

  test('for= activates the remote control without leaking a tap into it or its ancestors', async () => {
    const { before, after } = await clickAndSettle('.lab-txt-b', 'switchB.change')
    expect(delta(before, after, 'switchB.change'), '远程控件被激活').toBe(1)
    expect(delta(before, after, 'labelB.tap'), 'label 自己的 tap').toBe(1)
    expect(delta(before, after, 'switchB.tap'), '远程控件不派发自己的 tap').toBe(0)
    expect(delta(before, after, 'viewB.tap'), '远程控件的祖先不应收到 tap').toBe(0)
  })

  test('a nested native input gets focus from one tap, with no second tap on the label', async () => {
    const { before, after } = await clickAndSettle('.lab-txt-d', 'labelD.tap')
    expect(delta(before, after, 'labelD.tap'), 'label 自己的 tap').toBe(1)
    expect(delta(before, after, 'inputD.focus'), '内嵌输入框被聚焦').toBe(1)
    expect(await focusedTagInGuest(), 'render guest 里真实的 activeElement').toBe('INPUT')
  })

  test('an activated button emits its own tap and that tap bubbles to the label ancestors', async () => {
    const { before, after } = await clickAndSettle('.lab-txt-g', 'buttonG.tap')
    expect(delta(before, after, 'buttonG.tap'), 'button 派发自己的 tap').toBe(1)
    expect(delta(before, after, 'labelG.tap'), 'label 收到补发的与原始的各一次').toBe(2)
    expect(delta(before, after, 'viewG.tap'), '祖先 view 同样两次').toBe(2)
  })

  test('a remote button activated through for= bubbles its tap into its own ancestors', async () => {
    const { before, after } = await clickAndSettle('.lab-txt-h', 'buttonH.tap')
    expect(delta(before, after, 'buttonH.tap'), '远程 button 派发自己的 tap').toBe(1)
    expect(delta(before, after, 'viewH.tap'), '远程按钮的祖先收到冒泡的那次').toBe(1)
    expect(delta(before, after, 'labelH.tap'), 'label 只有原始序列那一次').toBe(1)
  })
})
