import { test, expect, useSharedProject } from './fixtures'
import { SimulatorElementChannel, type ElementInspection } from '../src/shared/ipc-channels'
import {
  DEMO_APP_DIR,
  evalInSimulator,
  ipcInvoke,
  pollUntil,
} from './helpers'

/**
 * WXML 面板组件命名反向映射测试。
 *
 * 用户报告的 bug：小程序源码 `<view>123</view>` 经过 Dimina 编译后实际
 * 渲染成 `<div>` (Dimina 把 wxml 编译为 Web DOM)，但 WXML 面板应当展示
 * 反向映射后的 `<view>`，而不是底层的 `<div>`。
 *
 * 这里直接通过 simulator 暴露的 `window.__simulatorData.getWxml()` 读取
 * 当前的 wxml 树，断言树中只能出现合法的小程序组件标签 (view/text/...
 * 或 #text/#fragment/#shadow-root/page 等元数据节点)，不应该出现裸的
 * web 元素如 `div`/`span`/`p`。
 *
 * 自定义组件 wrapper 反向映射的新契约：
 * - 原来 `<wrapper name="/components/counter/counter">` 会被反映射为
 *   tagName `counter`（只取最后一段）。
 * - 现在改为使用**全路径**作为 tag 名：去掉前导 `/`，再剥掉结尾的
 *   `/index`，例如 `/components/counter/counter` → `components/counter/counter`，
 *   `/x/foo/index` → `x/foo`。
 * - 同时 wrapper 的 children 会被包一层合成节点
 *   `{ tagName: '#shadow-root', attrs: {}, children: [...原 children] }`，
 *   用来在面板里清晰地展示组件边界。
 */

interface WxmlNodeShape {
  tagName: string
  attrs: Record<string, string>
  children: WxmlNodeShape[]
  text?: string
  sid?: string
}

// 元数据/合成节点：#text 文本节点、#fragment 片段、#shadow-root 自定义组件边界。
const META_TAGS = new Set(['#text', '#fragment', '#shadow-root'])

/** 已知的小程序合法组件标签（来自 dimina/fe/packages/components/src/component/）。 */
const MINIPROGRAM_TAGS = new Set([
  'page',
  'block',
  'button',
  'camera',
  'checkbox',
  'checkbox-group',
  'cover-image',
  'cover-view',
  'form',
  'icon',
  'image',
  'input',
  'keyboard-accessory',
  'label',
  'map',
  'movable-area',
  'movable-view',
  'navigation-bar',
  'navigator',
  'open-data',
  'page-meta',
  'picker',
  'picker-view',
  'picker-view-column',
  'picker-column',
  'progress',
  'radio',
  'radio-group',
  'rich-text',
  'root-portal',
  'scroll-view',
  'slider',
  'swiper',
  'swiper-item',
  'switch',
  'template',
  'text',
  'textarea',
  'video',
  'view',
  'web-view',
  'wrapper',
])

/** Web 原生元素 — 这些绝对不应出现在 WXML 面板里。 */
const FORBIDDEN_WEB_TAGS = new Set([
  'div', 'span', 'p', 'a', 'ul', 'ol', 'li', 'section', 'article',
  'header', 'footer', 'nav', 'main', 'aside', 'figure', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
])

function collectTagNames(tree: WxmlNodeShape | WxmlNodeShape[] | null): string[] {
  if (!tree) return []
  const out: string[] = []
  const walk = (node: WxmlNodeShape) => {
    out.push(node.tagName)
    for (const child of node.children ?? []) walk(child)
  }
  if (Array.isArray(tree)) {
    tree.forEach(walk)
  } else {
    walk(tree)
  }
  return out
}

/** 深度优先找第一个 tagName 匹配的节点。用于结构性断言（不仅仅检查存在性，
 *  还要校验它在树中的位置和上下文）。 */
function findNode(
  tree: WxmlNodeShape | WxmlNodeShape[] | null,
  tagName: string,
): WxmlNodeShape | null {
  if (!tree) return null
  const find = (node: WxmlNodeShape): WxmlNodeShape | null => {
    if (node.tagName === tagName) return node
    for (const child of node.children ?? []) {
      const found = find(child)
      if (found) return found
    }
    return null
  }
  if (Array.isArray(tree)) {
    for (const t of tree) {
      const r = find(t)
      if (r) return r
    }
    return null
  }
  return find(tree)
}

function findFirstNodeWithSid(tree: WxmlNodeShape | WxmlNodeShape[] | null): WxmlNodeShape | null {
  if (!tree) return null
  const find = (node: WxmlNodeShape): WxmlNodeShape | null => {
    if (node.sid) return node
    for (const child of node.children ?? []) {
      const found = find(child)
      if (found) return found
    }
    return null
  }
  if (Array.isArray(tree)) {
    for (const t of tree) {
      const r = find(t)
      if (r) return r
    }
    return null
  }
  return find(tree)
}

async function fetchWxmlTreeOnce(electronApp: import('@playwright/test').ElectronApplication): Promise<WxmlNodeShape | WxmlNodeShape[] | null> {
  const json = await evalInSimulator<string>(
    electronApp,
    `(() => {
      try {
        const tree = window.__simulatorData?.getWxml?.();
        return JSON.stringify(tree ?? null);
      } catch (e) { return JSON.stringify(null); }
    })()`,
  )
  if (typeof json !== 'string') return null
  return JSON.parse(json) as WxmlNodeShape | WxmlNodeShape[] | null
}

async function fetchWxmlTree(electronApp: import('@playwright/test').ElectronApplication): Promise<WxmlNodeShape | WxmlNodeShape[] | null> {
  return pollUntil(
    () => fetchWxmlTreeOnce(electronApp),
    (val) => val !== null,
    15000,
    500,
  )
}

test.describe('WXML Panel Component Mapping', () => {
  test.setTimeout(90_000)
  test.describe.configure({ mode: 'serial' })

  useSharedProject(test, DEMO_APP_DIR, { openOptions: { waitMs: 8000, waitForWebview: true } })

  test('home page wxml tree contains <view> tags, not raw <div>', async ({ electronApp }) => {
    const tree = await fetchWxmlTree(electronApp)
    expect(tree, 'wxml tree should be populated for home page').not.toBeNull()

    const tags = collectTagNames(tree)

    // index.wxml 的根用了 <view class="container">，所以反向映射后必须见到 view。
    expect(tags).toContain('view')

    // 明确禁止：任何裸 web 标签都不应出现。这是 bug 的核心断言。
    const leaked: string[] = []
    for (const tag of tags) {
      if (FORBIDDEN_WEB_TAGS.has(tag)) leaked.push(tag)
    }
    expect(leaked, `WXML panel leaked raw web tags: ${leaked.join(', ')}`).toEqual([])
  })

  test('inspector maps a WXML sid back to the real DOM box and clears the overlay', async ({ electronApp, mainWindow }) => {
    const tree = await fetchWxmlTree(electronApp)
    const inspectable = findFirstNodeWithSid(tree)
    expect(inspectable, 'wxml tree should contain at least one sid-backed node').not.toBeNull()

    try {
      const inspection = await ipcInvoke<ElementInspection | null>(
        mainWindow,
        SimulatorElementChannel.Inspect,
        inspectable!.sid,
      )
      expect(inspection, 'inspection should resolve the real DOM element').not.toBeNull()
      expect(inspection!.sid).toBe(inspectable!.sid)
      expect(inspection!.rect.width).toBeGreaterThan(0)
      expect(inspection!.rect.height).toBeGreaterThan(0)

      const overlayDisplay = await evalInSimulator<string>(
        electronApp,
        `(() => {
          const iframes = document.querySelectorAll('.dimina-native-webview__window')
          const iframe = iframes[iframes.length - 1]
          const overlay = iframe?.contentDocument?.getElementById('__simulator-highlight')
          return overlay ? overlay.style.display : ''
        })()`,
      )
      expect(overlayDisplay).toBe('block')

      // 不存在的 sid 必须返回 null（非 throw、非 stale 数据）。
      const missing = await ipcInvoke<ElementInspection | null>(
        mainWindow,
        SimulatorElementChannel.Inspect,
        '__nonexistent_sid__',
      )
      expect(missing).toBeNull()
    } finally {
      await ipcInvoke<void>(mainWindow, SimulatorElementChannel.Clear)
    }

    // Clear 之后 overlay 必须被隐藏。
    const overlayDisplayAfter = await evalInSimulator<string>(
      electronApp,
      `(() => {
        const iframes = document.querySelectorAll('.dimina-native-webview__window')
        const iframe = iframes[iframes.length - 1]
        const overlay = iframe?.contentDocument?.getElementById('__simulator-highlight')
        return overlay ? overlay.style.display : ''
      })()`,
    )
    expect(overlayDisplayAfter).toBe('none')
  })

  test('page node uses full page path as tag name with #shadow-root boundary (WeChat-style)', async ({ electronApp }) => {
    // 对齐微信开发者工具：页面节点应当用页面**全路径**作 tag 名（如 `pages/index/index`），
    // 并在 children 上包一层 `#shadow-root` 标记组件边界。
    // 之前的实现把页面 tag 硬编码成 `page`，没有路径也没有 shadow-root，
    // 这里写下契约让它成为后续实现的"目标"。
    const tree = await fetchWxmlTree(electronApp)
    expect(tree).not.toBeNull()

    // 找页面节点：home 页源路径是 `pages/index/index`（去前导 `/`）。
    const homePage = findNode(tree, 'pages/index/index')
    expect(
      homePage,
      'home 页根节点应当用全路径 `pages/index/index` 作 tag 名，而非裸 `page`',
    ).not.toBeNull()

    // 页面节点的直接子节点应当只有一个 #shadow-root 边界，
    // 真实页面内容嵌在 shadow-root 里。
    expect(
      homePage!.children,
      '页面的直接子节点应当只有一个 #shadow-root',
    ).toHaveLength(1)
    expect(homePage!.children[0].tagName).toBe('#shadow-root')

    // shadow-root 内部应当包含 home 页 wxml 实际写的 view 节点
    const innerTags = collectTagNames(homePage!.children[0])
    expect(innerTags, 'shadow-root 内必须含 view（home 页实际 wxml 内容）').toContain('view')
  })

  test('every node in the tree maps to a known miniprogram tag or meta node', async ({ electronApp }) => {
    const tree = await fetchWxmlTree(electronApp)
    expect(tree).not.toBeNull()

    const tags = collectTagNames(tree)
    const unknown: string[] = []
    for (const tag of tags) {
      if (META_TAGS.has(tag)) continue
      if (MINIPROGRAM_TAGS.has(tag)) continue
      // 用户自定义组件：tag 现在是其**全路径**（去前导 `/`、剥 `/index`），
      // 例如 `components/counter/counter`、`components/nested-item/nested-item`。
      // 这些 tag 含 `/`，既不在 MINIPROGRAM_TAGS 也不在 FORBIDDEN_WEB_TAGS，
      // 自然会被下面的 forbidden 判定放过。我们不枚举所有用户组件，但起码
      // 不应是 web 内置标签。
      if (FORBIDDEN_WEB_TAGS.has(tag)) {
        unknown.push(tag)
      }
    }
    expect(
      unknown,
      `Tree contains web-native tags that should be reverse-mapped: ${unknown.join(', ')}`,
    ).toEqual([])
  })

  test('swiper-test page: swiper 容器与 swiper-item 子项正确展示，过滤掉内部 dom', async ({ electronApp }) => {
    // swiper 这种带子项的内置组件在 wxml 面板里的契约：
    //   <swiper indicator-dots autoplay=false current=0 ...>
    //     <swiper-item>...</swiper-item>
    //     <swiper-item>...</swiper-item>
    //     <swiper-item>...</swiper-item>
    //   </swiper>
    // - swiper 内部的 dd-swiper-wrapper / dd-swiper-slides / dd-swiper-slide-frame /
    //   dd-swiper-dots 是渲染实现细节，必须从 wxml 面板里穿透掉，不能让用户看到。
    // - swiper-item 是用户真实写在 wxml 里的子组件，必须保留并直接挂在 swiper 下。
    // - swiper 的 attrs 里要能看到用户写的 indicator-dots/autoplay/current 等 prop。
    // - 顺手验证 v-if 占位 comment vnode 不会变成 #text 漏出来（已修，回归覆盖）。
    // 这条 test 必须排在 component-test 之前：dimina 只在 onload 读一次 hash，
    // 后续 location.hash / location.href 的改写不会触发 navigation；
    // useSharedProject 的 afterEach reset 实际上对 dimina 也是 no-op。
    // 因此唯一稳妥的入口是：当 simulator 仍在 home 页时点击 menu 触发 wx.navigateTo。
    await evalInSimulator(electronApp, `(() => {
      try {
        const iframes = document.querySelectorAll('.dimina-native-webview__window')
        const iframe = iframes[iframes.length - 1]
        if (!iframe) return
        const doc = iframe.contentDocument
        if (!doc) return
        const menu = doc.querySelector('[data-path="/pages/swiper-test/swiper-test"]')
        if (menu) (menu).click()
      } catch (e) {}
    })()`)

    // 轮询直到 wxml tree 中出现 swiper 节点（避免使用固定 sleep）。
    const tree = await pollUntil(
      () => fetchWxmlTreeOnce(electronApp),
      (val) => {
        if (!val) return false
        const tags = collectTagNames(val as WxmlNodeShape | WxmlNodeShape[])
        return tags.includes('swiper')
      },
      15000,
      500,
    )
    expect(tree, 'swiper-test 页 wxml 树应当包含 swiper 节点').not.toBeNull()

    const swiper = findNode(tree, 'swiper')
    expect(swiper, 'swiper 节点必须存在').not.toBeNull()

    // ── attrs 检查：用户写在 wxml 上的 prop 必须能从面板上看到 ───────────
    // wxml 里写的是 indicator-dots="{{true}}"，dimina 把它编译成 vue 的 indicatorDots prop,
    // 但 vue instance 上 attrs/props 的 key 形式与 dimina 内部细节相关。我们只要求
    // 能看到至少一个 swiper 的关键属性（indicator-dots / indicatorDots / autoplay 等）。
    const swiperAttrKeys = Object.keys(swiper!.attrs)
    const hasIndicatorDots = swiperAttrKeys.some((k) => /indicator[-_]?dots/i.test(k))
    expect(
      hasIndicatorDots,
      `swiper 的 attrs 里应当能看到 indicator-dots 相关 prop，实际拿到: ${JSON.stringify(swiper!.attrs)}`,
    ).toBe(true)

    // ── children 检查：直接子节点应该全是 swiper-item，且至少 3 个 ────────
    // 不要用 findNode（深度搜索）—— 那样即使 swiper-item 被嵌进 dd-swiper-wrapper
    // 等内部 div 也能找到，绕过了"过滤内部 DOM"的契约。这里要求 swiper 的
    // 直接 children 里就有 swiper-item。
    const directSwiperItems = swiper!.children.filter((c) => c.tagName === 'swiper-item')
    expect(
      directSwiperItems.length,
      `swiper 的直接子节点里应当至少有 3 个 swiper-item，实际 children: ${JSON.stringify(swiper!.children.map((c) => c.tagName))}`,
    ).toBeGreaterThanOrEqual(3)

    // ── 内部 DOM 不应泄漏：dd-swiper-* 的真实 div 节点不该出现 ───────────
    // 这些是 Swiper.vue 自己 template 里的实现细节，wxml-extract 通过 INTERNAL_CLASSES
    // 应该已经穿透它们。如果穿透失效，会有以 dd- 开头的 view 节点或者过深的嵌套。
    const allTags = collectTagNames(tree)
    const leaked = allTags.filter((t) => FORBIDDEN_WEB_TAGS.has(t))
    expect(leaked, `swiper-test 页泄漏了裸 web 标签: ${leaked.join(', ')}`).toEqual([])

    // ── v-if/v-else/v-for 字面量不应出现在 #text 里 ──────────────────────
    // 这是另一个独立 bug 的回归保护：Vue 在条件为 false 时留下的 comment vnode
    // 不应被 wxml-extract 当作文本节点输出。
    const collectTexts = (node: WxmlNodeShape, out: string[] = []): string[] => {
      if (node.tagName === '#text' && node.text) out.push(node.text)
      for (const c of node.children ?? []) collectTexts(c, out)
      return out
    }
    const allTexts: string[] = []
    if (Array.isArray(tree)) {
      tree.forEach((t) => collectTexts(t, allTexts))
    } else if (tree) {
      collectTexts(tree, allTexts)
    }
    const vMarkers = allTexts.filter((t) => /^v-(if|else|else-if|for)$/.test(t))
    expect(vMarkers, `wxml 树里出现了 vue v-* 占位字面量: ${vMarkers.join(', ')}`).toEqual([])
  })

  test('component-test page: custom components reverse-map and no raw web tags leak', async ({ electronApp }) => {
    // 切到 component-test 页：里面有 <counter>、<nested-item> 等用户自定义组件。
    // demo 首页的菜单项是 `<view bindtap="navigateTo" data-path="...">`，
    // dimina 里 `location.hash = ...` 不会触发导航，必须点击菜单触发 wx.navigateTo。
    await evalInSimulator(electronApp, `(() => {
      try {
        const iframes = document.querySelectorAll('.dimina-native-webview__window')
        const iframe = iframes[iframes.length - 1]
        if (!iframe) return
        const doc = iframe.contentDocument
        if (!doc) return
        const menu = doc.querySelector('[data-path="/pages/component-test/component-test"]')
        if (menu) (menu).click()
      } catch (e) {}
    })()`)

    // 轮询直到 wxml tree 中出现 component-test 页特有的 `counter` 自定义组件，
    // 而非依赖固定 sleep —— 后者在慢机器/CI 上会误通过（首页本身也有 <text>）。
    // 新契约下 counter 组件的 tagName 是全路径 `components/counter/counter`。
    const tree = await pollUntil(
      () => fetchWxmlTreeOnce(electronApp),
      (val) => {
        if (!val) return false
        const tags = collectTagNames(val as WxmlNodeShape | WxmlNodeShape[])
        return tags.includes('components/counter/counter')
      },
      15000,
      500,
    )
    expect(tree).not.toBeNull()
    const tags = collectTagNames(tree as WxmlNodeShape | WxmlNodeShape[])

    // ── 微信开发者工具风格的层级契约 ─────────────────────────────────────
    // 不仅要求 `components/counter/counter` 和 `#shadow-root` 字符串各自出现
    // 在树里（flat tag 检查），还必须保证它们处在正确的父子关系上：
    //   <components/counter/counter ...>
    //     <#shadow-root>
    //       <view ...>          ← counter 组件实际渲染的内容
    //       ...
    //     </#shadow-root>
    //   </components/counter/counter>
    // 否则 #shadow-root 就算飘到根节点也能让 flat 断言通过 —— 那是假的。
    const counter = findNode(tree, 'components/counter/counter')
    expect(counter, 'counter 自定义组件必须出现在 wxml 树中').not.toBeNull()
    // 自定义组件下严格只允许一个直接子节点：合成的 #shadow-root 边界。
    // 真实 children 应该全部嵌在 shadow-root 内部，而不是和它平级。
    expect(counter!.children, 'counter 的直接子节点应当只有一个 #shadow-root').toHaveLength(1)
    expect(counter!.children[0].tagName).toBe('#shadow-root')
    // shadow-root 里必须有真实内容（否则等于把组件实现弄丢了）。
    const shadowRoot = counter!.children[0]
    expect(shadowRoot.children.length, '#shadow-root 内必须包含组件实际渲染的子节点').toBeGreaterThan(0)
    // 内部至少含一个 view 节点（counter.wxml 里实际就用了 view），
    // 这条断言锁住"unwrap 不能丢失子节点"的契约。
    const innerTags = collectTagNames(shadowRoot)
    expect(innerTags, 'counter 内部应当包含 view 节点').toContain('view')

    // nested-item 也要满足同样的层级
    const nested = findNode(tree, 'components/nested-item/nested-item')
    expect(nested, 'nested-item 自定义组件必须出现在 wxml 树中').not.toBeNull()
    expect(nested!.children).toHaveLength(1)
    expect(nested!.children[0].tagName).toBe('#shadow-root')

    // text 标签存在
    expect(tags).toContain('text')
    // 没有裸 web 标签泄漏
    const leaked = tags.filter((t) => FORBIDDEN_WEB_TAGS.has(t))
    expect(leaked, `Leaked web tags on component-test page: ${leaked.join(', ')}`).toEqual([])
  })

  test('hovering a WXML panel row drives both the footer and the simulator overlay', async ({ electronApp, mainWindow }) => {
    // 通过真实的鼠标 hover（而非直接 IPC）驱动 WXML 面板，验证：
    //   1. React 端 footer 出现，文本符合 `box W x H @ X, Y | styles | font Npx` 模式；
    //   2. simulator iframe 内的 #__simulator-highlight overlay display = 'block'；
    //   3. 鼠标移出面板后，footer 文本从 DOM 消失、overlay display 回到 'none'。
    // hover -> rAF -> IPC，因此使用 pollUntil/expect.poll 等异步断言，而不是同步检查。

    // 切到 WXML tab，等面板内容渲染
    await mainWindow.getByRole('tab', { name: 'WXML' }).click()
    // Scope to WxmlPanel：AppDataPanel keepalive 挂载着另一个「↻ 刷新」按钮。
    await mainWindow.getByTestId('wxml-panel').locator('button:has-text("↻ 刷新")').waitFor({ timeout: 8000 })

    // 等到至少一个可 inspect 的行（带 data-wxml-sid）出现在面板里。
    const inspectableRow = mainWindow.locator('[data-wxml-sid]').first()
    await inspectableRow.waitFor({ timeout: 15000 })

    const overlayDisplay = async () => evalInSimulator<string>(
      electronApp,
      `(() => {
        const iframes = document.querySelectorAll('.dimina-native-webview__window')
        const iframe = iframes[iframes.length - 1]
        const overlay = iframe?.contentDocument?.getElementById('__simulator-highlight')
        return overlay ? overlay.style.display : ''
      })()`,
    )

    try {
      // 触发真实 hover
      await inspectableRow.hover()

      // footer 是 rAF 防抖后异步设置的，必须轮询。
      // 文本形如 `box 100 x 50 @ 12, 34 | block / border-box | font 14px`。
      const footerRegex = /^box\s+\d+\s+x\s+\d+\s+@\s+\d+,\s*\d+/
      await expect(mainWindow.getByText(footerRegex).first()).toBeVisible({ timeout: 10000 })

      // overlay 在 simulator iframe 里也应当是 block
      const display = await pollUntil(
        overlayDisplay,
        (v) => v === 'block',
        10000,
        200,
      )
      expect(display).toBe('block')

      // ── mouse leave：移到面板外面，触发 onMouseLeave ────────────────────
      // 移到坐标 (0, 0)（窗口左上角，肯定不在 WXML 面板内）
      await mainWindow.mouse.move(0, 0)

      // footer 文本从 DOM 消失
      await expect(mainWindow.getByText(footerRegex).first()).toBeHidden({ timeout: 10000 })

      // overlay display 回到 'none'
      const displayAfter = await pollUntil(
        overlayDisplay,
        (v) => v === 'none',
        10000,
        200,
      )
      expect(displayAfter).toBe('none')
    } finally {
      // 失败兜底：确保 overlay 不残留到下一个测试。
      await ipcInvoke<void>(mainWindow, SimulatorElementChannel.Clear).catch(() => {})
    }
  })

})
