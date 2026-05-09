import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SimulatorChannel } from '../../shared/ipc-channels.js'

vi.mock('electron', () => ({
  ipcRenderer: {
    sendToHost: vi.fn(),
    on: vi.fn(),
  },
}))

import { ipcRenderer } from 'electron'
import { sendWxmlTree, setupWxmlObserver } from './wxml'

let disposeObserver: (() => void) | null = null

/** Helper: build a minimal mock Vue component instance tree. */
function makeInstance(
  tagName: string,
  props: Record<string, unknown> = {},
  children: Record<string, unknown>[] = [],
) {
  return {
    type: { __tagName: tagName },
    props,
    subTree: {
      children: children.map((child) => ({ component: child })),
    },
  }
}

/**
 * Create a mock iframe with class "dimina-native-webview__window"
 * and mount a Vue app instance on its contentDocument.body.
 */
function createMockIframe(instance?: Record<string, unknown>): HTMLIFrameElement {
  const iframe = document.createElement('iframe')
  iframe.className = 'dimina-native-webview__window'
  document.body.appendChild(iframe)

  if (instance) {
    mountVueAppOnIframe(iframe, instance)
  }
  return iframe
}

function mountVueAppOnIframe(
  iframe: HTMLIFrameElement,
  instance: Record<string, unknown>,
) {
  const doc = iframe.contentDocument!
  Object.defineProperty(doc.body, '__vue_app__', {
    value: { _instance: instance },
    configurable: true,
    writable: true,
  })
}

function cleanupIframes() {
  document.querySelectorAll('.dimina-native-webview__window').forEach((el) => el.remove())
}

describe('sendWxmlTree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanupIframes()
  })

  it('does nothing when no iframe exists', () => {
    sendWxmlTree()
    expect(ipcRenderer.sendToHost).not.toHaveBeenCalled()
  })

  it('does nothing when iframe has no __vue_app__', () => {
    createMockIframe() // no instance
    sendWxmlTree()
    expect(ipcRenderer.sendToHost).not.toHaveBeenCalled()
  })

  it('sends a simple single-node tree', () => {
    const instance = makeInstance('view', { class: 'container' })
    createMockIframe(instance)

    sendWxmlTree()

    expect(ipcRenderer.sendToHost).toHaveBeenCalledWith(
      SimulatorChannel.Wxml,
      expect.objectContaining({
        tagName: 'view',
        attrs: { class: 'container' },
        children: [],
      }),
    )
  })

  it('extracts nested component children', () => {
    const child = makeInstance('text', { value: 'hello' })
    const root = makeInstance('view', {}, [child])
    createMockIframe(root)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.tagName).toBe('view')
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0].tagName).toBe('text')
  })

  it('resolves dd- prefix names correctly', () => {
    const instance = {
      type: { __name: 'dd-button' },
      props: {},
      subTree: { children: [] },
    }
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.tagName).toBe('button')
  })

  it('resolves dd-page to page', () => {
    const instance = {
      type: { name: 'dd-page' },
      props: {},
      subTree: { children: [] },
    }
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.tagName).toBe('page')
  })

  it('resolves CamelCase DdButton to button', () => {
    const instance = {
      type: { name: 'DdButton' },
      props: {},
      subTree: { children: [] },
    }
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.tagName).toBe('button')
  })

  it('filters out function and undefined props', () => {
    const instance = makeInstance('view', {
      visible: true,
      onClick: () => {},
      missing: undefined,
      title: 'hi',
    })
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.attrs).toEqual({ visible: 'true', title: 'hi' })
  })

  it('filters out data and __-prefixed props', () => {
    const instance = makeInstance('view', {
      data: { complex: true },
      __internal: 'hidden',
      label: 'show',
    })
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.attrs).toEqual({ label: 'show' })
  })

  it('filters out false boolean props', () => {
    const instance = makeInstance('view', { disabled: false, enabled: true })
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.attrs).toEqual({ enabled: 'true' })
  })

  it('extracts text VNode children', () => {
    const instance = {
      type: { __tagName: 'text' },
      props: {},
      subTree: {
        children: 'Hello World',
        type: Symbol('Text'),
      },
    }
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    // The text is extracted as a child text node
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0].tagName).toBe('#text')
    expect(tree.children[0].text).toBe('Hello World')
  })

  it('skips Vue Comment vnodes (v-if/v-else placeholders) instead of rendering as text', () => {
    // wxml `wx:if="{{false}}"` 编译成 Vue 的 v-if，条件为 false 时 Vue 渲染
    // `<!-- v-if -->` 占位 comment vnode（type=Symbol(Comment), children='v-if'）。
    // 这种 comment 不应该出现在 WXML 面板里 —— 它是 Vue 内部锚点，不是用户内容。
    const realChild = makeInstance('button', {})
    const instance = {
      type: { __tagName: 'view' },
      props: {},
      subTree: {
        children: [
          // 一个真实子节点
          { component: realChild },
          // 三种 v-* comment 占位都得跳过
          { type: Symbol('Comment'), children: 'v-if' },
          { type: Symbol('Comment'), children: 'v-else' },
          { type: Symbol('v-cmt'), children: 'v-for' },
        ],
      },
    }
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.tagName).toBe('view')
    // 只剩真实子节点 button，没有 v-if/v-else/v-for 残留
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0].tagName).toBe('button')
    // 树里所有 #text 节点都不应是 v-* 字面量
    const collect = (n: { tagName: string; text?: string; children: unknown[] }, out: string[] = []): string[] => {
      if (n.tagName === '#text' && n.text) out.push(n.text)
      for (const c of n.children) collect(c as { tagName: string; text?: string; children: unknown[] }, out)
      return out
    }
    const allTexts = collect(tree)
    expect(allTexts.some((t) => /^v-/.test(t))).toBe(false)
  })

  it('handles fragment VNodes (symbol type) by recursing into children', () => {
    const innerChild = makeInstance('button', { type: 'primary' })
    const instance = {
      type: { __tagName: 'view' },
      props: {},
      subTree: {
        children: [
          {
            type: Symbol('Fragment'),
            children: [{ component: innerChild }],
          },
        ],
      },
    }
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0].tagName).toBe('button')
  })

  // ── Reverse-mapping (web tag -> miniprogram tag) regression cases ─────
  //
  // Dimina components are registered as `dd-view`, `dd-text`, etc. and the
  // installer (`withInstall`) sets `__tagName` from `__name`. The tests
  // below cover scenarios where `__tagName` is absent and we must fall
  // back to `__name`/`name` reverse mapping.

  it('reverse-maps PascalCase __name (View) to view when __tagName is absent', () => {
    const instance = {
      type: { __name: 'View' },
      props: {},
      subTree: { children: [] },
    }
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.tagName).toBe('view')
  })

  it('reverse-maps PascalCase __name (ScrollView) to scroll-view', () => {
    const instance = {
      type: { __name: 'ScrollView' },
      props: {},
      subTree: { children: [] },
    }
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.tagName).toBe('scroll-view')
  })

  it('reverse-maps PascalCase __name (CoverView) to cover-view', () => {
    const instance = {
      type: { __name: 'CoverView' },
      props: {},
      subTree: { children: [] },
    }
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.tagName).toBe('cover-view')
  })

  it('never emits raw web tags (div/span) when only native elements appear in subTree', () => {
    // Models a pathological case: an instance with no identifiable __name/
    // __tagName whose subTree is a raw <div> element. We must not surface
    // 'div' as a tag in the tree — it should fall through to children or
    // be dropped, not become a node.
    const instance = {
      type: {}, // no __name, no __tagName, no name
      props: {},
      subTree: {
        type: 'div', // native element
        children: [],
      },
    }
    createMockIframe(instance)

    sendWxmlTree()

    // Either no IPC was sent (tree dropped because nothing identifiable),
    // or the sent tree contains no native web tags. Both are acceptable —
    // the only forbidden outcome is surfacing 'div'/'span' as a tag.
    const calls = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls
    if (calls.length === 0) return // dropped — fine
    const tree = calls[0]![1]
    const collect = (n: unknown, out: string[] = []): string[] => {
      if (!n || typeof n !== 'object') return out
      const node = n as { tagName?: string; children?: unknown[] }
      if (node.tagName) out.push(node.tagName)
      for (const c of node.children ?? []) collect(c, out)
      return out
    }
    const tags = collect(tree)
    expect(tags).not.toContain('div')
    expect(tags).not.toContain('span')
  })

  it('matches upstream camelCaseToUnderscore on digit-bearing names (no split before/after digits)', () => {
    // 上游 dimina `camelCaseToUnderscore` 用 /([a-z])([A-Z])/，不切分数字。
    // 这里锁定我们的 fallback 与上游一致：`View3D` -> `view3d`，不应是 `view3-d`。
    const instance = {
      type: { __name: 'View3D' },
      props: {},
      subTree: { children: [] },
    }
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.tagName).toBe('view3d')
  })

  // ── Wrapper unwrap (user-defined component reverse-mapping) ──────────
  //
  // Dimina hosts every user-defined component inside `<wrapper name="<path>">`.
  // The WXML panel must reverse-map this back to the source-level tag the
  // user wrote (the last path segment, optionally minus `/index`).

  it('unwraps wrapper into the full user component path', () => {
    const innerText = makeInstance('text', {})
    const instance = makeInstance(
      'wrapper',
      { name: '/components/counter/counter' },
      [innerText],
    )
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    // 对齐微信开发者工具：自定义组件用全路径作 tag 名
    expect(tree.tagName).toBe('components/counter/counter')
    // `name` 属性是 dimina 内部包装信息，应当从面板上的 attrs 里去掉
    expect(tree.attrs).not.toHaveProperty('name')
    // 自定义组件下插入合成的 `#shadow-root` 把组件本身和内部实现分隔开
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0].tagName).toBe('#shadow-root')
    expect(tree.children[0].attrs).toEqual({})
    expect(tree.children[0].children).toHaveLength(1)
    expect(tree.children[0].children[0].tagName).toBe('text')
  })

  it('strips trailing /index when unwrapping wrapper', () => {
    const innerText = makeInstance('text', {})
    const instance = makeInstance('wrapper', { name: '/components/foo/index' }, [innerText])
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.tagName).toBe('components/foo')
    // 仍旧包一层 shadow-root
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0].tagName).toBe('#shadow-root')
    expect(tree.children[0].children[0].tagName).toBe('text')
  })

  it('falls back to wrapper when path is just /index (nothing left after stripping)', () => {
    // 边界：剥光 `/index` 后没有剩余段，退回 wrapper 避免空 tagName
    const instance = makeInstance('wrapper', { name: '/index' })
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.tagName).toBe('wrapper')
  })

  it('preserves non-name attrs and children through wrapper unwrap', () => {
    const instance = makeInstance('wrapper', {
      name: '/components/counter/counter',
      'bind:change': 'onCounterChange',
      label: 'demo',
    })
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.tagName).toBe('components/counter/counter')
    expect(tree.attrs).toEqual({ 'bind:change': 'onCounterChange', label: 'demo' })
    // 没有真实子节点时不插入 shadow-root，children 保持空数组
    expect(tree.children).toEqual([])
  })

  it('leaves wrapper tag alone when name attr is missing or empty', () => {
    const instance = makeInstance('wrapper', {})
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    // 没法推导真实组件名，保持 wrapper（避免误展示成空字符串）
    expect(tree.tagName).toBe('wrapper')
  })

  it('does not unwrap when name attr is a user-supplied non-path value', () => {
    // 用户写 `<counter name="x">`，与 wrapper 内部 `name=path` 在 Vue prop 层冲突。
    // dimina 自己生成的路径必以 `/` 开头；用户字面量几乎不会。这里以 `/` 为启发避免误剥。
    const instance = makeInstance('wrapper', { name: 'user-name' })
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.tagName).toBe('wrapper')
    expect(tree.attrs).toEqual({ name: 'user-name' })
  })

  it('preserves wrapper children inside shadow-root when unwrapping', () => {
    // unwrap 不应丢失子节点；子节点会被包一层 #shadow-root
    const innerText = makeInstance('text', {})
    const instance = makeInstance(
      'wrapper',
      { name: '/components/counter/counter' },
      [innerText],
    )
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.tagName).toBe('components/counter/counter')
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0].tagName).toBe('#shadow-root')
    expect(tree.children[0].children).toHaveLength(1)
    expect(tree.children[0].children[0].tagName).toBe('text')
  })

  // ── Page node: full path + #shadow-root (WeChat-style) ────────────────
  //
  // dimina runtime.js 在 dd-page 的 setup() 里调用 provide('path', path)
  // 把页面路径暴露给 Vue 的 provide/inject 体系。devtools 应该利用这个
  // 信息把页面节点的 tagName 从硬编码的 `page` 升级为页面全路径
  // （如 `pages/index/index`），并把页面 children 包一层 #shadow-root。

  it('uses page path from provides.path when proxy.__page__ marker is present', () => {
    // 模拟 dimina runtime dd-page setup 写入的两个标记：
    //   instance.proxy.__page__ = true
    //   provide('path', path)  → instance.provides.path
    // 缺一不可（避免子节点继承 provides 时被误判）。
    const innerView = makeInstance('view', {})
    const instance = {
      type: { __scopeId: 'data-v-abc' },
      props: {},
      proxy: { __page__: true },
      provides: { path: '/pages/index/index' },
      subTree: { children: [{ component: innerView }] },
    }
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.tagName).toBe('pages/index/index')
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0].tagName).toBe('#shadow-root')
    expect(tree.children[0].children).toHaveLength(1)
    expect(tree.children[0].children[0].tagName).toBe('view')
  })

  it('handles page path without leading slash (real runtime emits both forms)', () => {
    // 实测 dimina runtime 上 home 页 provides.path 是 `pages/index/index`（无前导 `/`）
    const instance = {
      type: { __scopeId: 'data-v-abc' },
      props: {},
      proxy: { __page__: true },
      provides: { path: 'pages/index/index' },
      subTree: { children: [] },
    }
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.tagName).toBe('pages/index/index')
  })

  it('does NOT treat instance as page when proxy.__page__ marker is absent', () => {
    // 子节点会继承 provides.path（Vue Object.create 链式 provides）。
    // 缺 __page__ 标记的实例不应被误判为页面 —— 否则页面下每个子组件
    // 都会被错误地命名成页面全路径。
    // 这里构造一个有 components（避免走透明 template 分支）但没有
    // proxy.__page__ 的实例，断言它走老路径返回 'page' 而非 page path。
    const instance = {
      type: {
        __scopeId: 'data-v-child',
        components: { 'dd-something': {} },
      },
      props: {},
      // 有 provides.path 但缺 proxy.__page__（模拟子组件继承场景）
      provides: { path: '/pages/index/index' },
      subTree: { children: [] },
    }
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.tagName).not.toBe('pages/index/index')
    // 走老路径返回 'page'（__scopeId && components）
    expect(tree.tagName).toBe('page')
  })

  it('falls back to plain `page` tagName when proxy.__page__ is absent and matches old detection', () => {
    // 老路径：__scopeId && components 时返回 'page'
    const instance = {
      type: {
        __scopeId: 'data-v-abc',
        components: { 'dd-something': {} },
      },
      props: {},
      // 没有 proxy.__page__
      subTree: { children: [] },
    }
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.tagName).toBe('page')
    expect(tree.children).toEqual([])
  })

  it('reverse-maps even when type only has lowercased name (e.g. legacy registration)', () => {
    // Some Vue setups expose `type.name` (not __name) as the component
    // identifier. Make sure the lowercased fallback also reverse-maps.
    const instance = {
      type: { name: 'View' },
      props: {},
      subTree: { children: [] },
    }
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    // PascalCase 'View' should map to 'view'. Currently the code only
    // strips a leading 'Dd' prefix; bare PascalCase falls through.
    expect(tree.tagName).toBe('view')
  })
})

describe('setupWxmlObserver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    disposeObserver = null
  })

  afterEach(() => {
    disposeObserver?.()
    cleanupIframes()
    vi.useRealTimers()
  })

  it('sends tree immediately when iframe with app is already present', () => {
    const instance = makeInstance('page')
    createMockIframe(instance)

    disposeObserver = setupWxmlObserver()

    expect(ipcRenderer.sendToHost).toHaveBeenCalledWith(
      SimulatorChannel.Wxml,
      expect.objectContaining({ tagName: 'page' }),
    )
  })

  it('retries via interval when iframe is not yet present', () => {
    disposeObserver = setupWxmlObserver()
    expect(ipcRenderer.sendToHost).not.toHaveBeenCalled()

    // Add iframe with Vue app and advance past the 500ms interval
    const instance = makeInstance('page')
    createMockIframe(instance)
    vi.advanceTimersByTime(500)

    expect(ipcRenderer.sendToHost).toHaveBeenCalledWith(
      SimulatorChannel.Wxml,
      expect.objectContaining({ tagName: 'page' }),
    )
  })
})
