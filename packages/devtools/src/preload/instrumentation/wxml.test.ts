import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// wxml.ts → runtime/bridge.ts → shared/expose.ts imports `contextBridge` from
// 'electron'. Without this mock the suite loads the real electron module, which
// throws when the electron binary is absent (e.g. CI's `pnpm install
// --ignore-scripts`). The tests never call electron, so stubs suffice.
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn(),
  },
  ipcRenderer: {
    on: vi.fn(),
    sendToHost: vi.fn(),
  },
}))

// The migration replaces `installWxmlInstrumentation` / `setupWxmlObserver` /
// `sendWxmlTree` with a single `createWxmlSource(): MiniappSnapshotSource`.
// The tree-walking logic (`walkInstance` & friends) is UNCHANGED by the
// migration — it is now reached through `createWxmlSource().start()` /
// `.snapshot()` instead of `sendWxmlTree()`. The source no longer touches IPC.
import { createWxmlSource } from './wxml'

let disposeSource: (() => void) | null = null

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

// ── createWxmlSource — tree extraction / walkInstance / node mapping ─────
//
// UNCHANGED by the migration: the tree-walking logic is not touched. These
// tests exercise `walkInstance` & friends and assert on the produced node
// tree exactly as before — only the call surface moved from `sendWxmlTree()`
// + `ipcRenderer.sendToHost` to `createWxmlSource().start()` + `.snapshot()`.
// With a page already mounted, `start()` computes the tree synchronously, so
// `snapshot()` returns it immediately. No fake timers are needed here.
describe('createWxmlSource — tree extraction', () => {
  let src: ReturnType<typeof createWxmlSource> | null = null

  /** Start a source over the currently-mounted iframe and return its snapshot. */
  function extract() {
    src = createWxmlSource()
    src.start(vi.fn())
    return src.snapshot()
  }

  /** Count nodes in the tree (including the root) whose tagName equals `tag`. */
  function countNodesByTag(node: { tagName: string; children?: unknown[] }, tag: string): number {
    const self = node.tagName === tag ? 1 : 0
    const kids = (node.children ?? []) as { tagName: string; children?: unknown[] }[]
    return self + kids.reduce((n, c) => n + countNodesByTag(c, tag), 0)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    src = null
  })

  afterEach(() => {
    src?.dispose()
    cleanupIframes()
  })

  it('snapshot() is null when no iframe exists', () => {
    expect(extract()).toBeNull()
  })

  it('snapshot() is null when iframe has no __vue_app__', () => {
    createMockIframe() // no instance
    expect(extract()).toBeNull()
  })

  it('extracts a simple single-node tree', () => {
    const instance = makeInstance('view', { class: 'container' })
    createMockIframe(instance)

    const tree = extract()

    expect(tree).toEqual(
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

    const tree = extract()!
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

    const tree = extract()!
    expect(tree.tagName).toBe('button')
  })

  it('resolves dd-page to page', () => {
    const instance = {
      type: { name: 'dd-page' },
      props: {},
      subTree: { children: [] },
    }
    createMockIframe(instance)

    const tree = extract()!
    expect(tree.tagName).toBe('page')
  })

  it('resolves CamelCase DdButton to button', () => {
    const instance = {
      type: { name: 'DdButton' },
      props: {},
      subTree: { children: [] },
    }
    createMockIframe(instance)

    const tree = extract()!
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

    const tree = extract()!
    expect(tree.attrs).toEqual({ visible: 'true', title: 'hi' })
  })

  it('filters out data and __-prefixed props', () => {
    const instance = makeInstance('view', {
      data: { complex: true },
      __internal: 'hidden',
      label: 'show',
    })
    createMockIframe(instance)

    const tree = extract()!
    expect(tree.attrs).toEqual({ label: 'show' })
  })

  it('filters out false boolean props', () => {
    const instance = makeInstance('view', { disabled: false, enabled: true })
    createMockIframe(instance)

    const tree = extract()!
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

    const tree = extract()!
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

    const tree = extract()!
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

    const tree = extract()!
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

    const tree = extract()!
    expect(tree.tagName).toBe('view')
  })

  it('reverse-maps PascalCase __name (ScrollView) to scroll-view', () => {
    const instance = {
      type: { __name: 'ScrollView' },
      props: {},
      subTree: { children: [] },
    }
    createMockIframe(instance)

    const tree = extract()!
    expect(tree.tagName).toBe('scroll-view')
  })

  it('reverse-maps PascalCase __name (CoverView) to cover-view', () => {
    const instance = {
      type: { __name: 'CoverView' },
      props: {},
      subTree: { children: [] },
    }
    createMockIframe(instance)

    const tree = extract()!
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

    const tree = extract()
    // Either no tree was produced (dropped because nothing identifiable),
    // or the tree contains no native web tags. Both are acceptable —
    // the only forbidden outcome is surfacing 'div'/'span' as a tag.
    if (tree === null) return // dropped — fine
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

    const tree = extract()!
    expect(tree.tagName).toBe('view3d')
  })

  // ── dd-wrapper transparency + component/page path identity ───────────
  //
  // dimina wraps every custom-component template root in `<dd-wrapper
  // name="<path>">`. The enclosing component instance already carries that
  // same path via `type.name`, so the wrapper is redundant scaffolding: it
  // must pass its children through instead of emitting a second path node.
  // A `wrapper` WITHOUT a path-shaped `name` is not scaffolding and stays a
  // literal `wrapper` node.

  it('collapses the double Vue-instance layer (component + its dd-wrapper subTree root) into ONE node', () => {
    // Regression for the doubled-node bug: a real custom component renders as
    // TWO nested Vue instances that both carry the path — the outer component
    // instance (holding the user's usage props) and its subTree root
    // `dd-wrapper` (holding only the fell-through `bind:change`). The panel
    // used to show BOTH as `components/counter/counter`, each with its own
    // #shadow-root. It must now show exactly one.
    const inner = makeInstance('view', { class: 'counter-wrapper' })
    const wrapper = {
      type: { __tagName: 'wrapper' },
      props: { name: '/components/counter/counter', 'bind:change': 'onCounterChange' },
      subTree: { children: [{ component: inner }] },
    }
    const component = {
      type: { name: '/components/counter/counter' },
      props: { label: '默认计数器', initial: 0, step: 1, 'bind:change': 'onCounterChange' },
      subTree: { children: [{ component: wrapper }] },
    }
    createMockIframe(component)

    const tree = extract()!
    expect(tree.tagName).toBe('components/counter/counter')
    // The OUTER instance's usage props surface (numbers stringified) — the
    // wrapper's own (redundant) `bind:change` does not double them up.
    expect(tree.attrs).toEqual({
      label: '默认计数器',
      initial: '0',
      step: '1',
      'bind:change': 'onCounterChange',
    })
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0].tagName).toBe('#shadow-root')
    expect(tree.children[0].children).toHaveLength(1)
    expect(tree.children[0].children[0].tagName).toBe('view')
    expect(countNodesByTag(tree, 'components/counter/counter')).toBe(1)
    expect(countNodesByTag(tree, 'wrapper')).toBe(0)
  })

  it('a path-named wrapper nested under its owning component is transparent (no wrapper tag, no doubled path)', () => {
    const innerText = makeInstance('text', {})
    const wrapper = {
      type: { __tagName: 'wrapper' },
      props: { name: '/components/foo/foo' },
      subTree: { children: [{ component: innerText }] },
    }
    const component = {
      type: { name: '/components/foo/foo' },
      props: {},
      subTree: { children: [{ component: wrapper }] },
    }
    createMockIframe(component)

    const tree = extract()!
    expect(tree.tagName).toBe('components/foo/foo')
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0].tagName).toBe('#shadow-root')
    expect(tree.children[0].children).toHaveLength(1)
    expect(tree.children[0].children[0].tagName).toBe('text')
    expect(countNodesByTag(tree, 'wrapper')).toBe(0)
    expect(countNodesByTag(tree, 'components/foo/foo')).toBe(1)
  })

  it('surfaces a component path with a trailing /index segment verbatim (no path stripping)', () => {
    const instance = { type: { name: '/components/foo/index' }, props: {}, subTree: { children: [] } }
    createMockIframe(instance)

    const tree = extract()!
    expect(tree.tagName).toBe('components/foo/index')
  })

  it('leaves wrapper tag alone when name attr is missing or empty', () => {
    const instance = makeInstance('wrapper', {})
    createMockIframe(instance)

    const tree = extract()!
    // 没法推导真实组件路径，保持 wrapper（避免误展示成空字符串）
    expect(tree.tagName).toBe('wrapper')
  })

  it('does not treat a user-supplied non-path name as scaffolding', () => {
    // 用户写 `<counter name="x">`，与 dd-wrapper 内部 `name=path` 在 Vue prop 层冲突。
    // dimina 自己生成的路径必以 `/` 开头；用户字面量几乎不会。这里以 `/` 为启发避免误吞。
    const instance = makeInstance('wrapper', { name: 'user-name' })
    createMockIframe(instance)

    const tree = extract()!
    expect(tree.tagName).toBe('wrapper')
    expect(tree.attrs).toEqual({ name: 'user-name' })
  })

  // ── Page node: full path + #shadow-root (WeChat-style) ────────────────
  //
  // The render runtime sets each compiled page's Vue `type.name` to its
  // miniprogram module path. devtools trusts that directly (see
  // `resolveTagName`) to upgrade the page node's tagName from the hardcoded
  // `page` to the full path (e.g. `pages/index/index`), and wraps the page's
  // children in a synthetic #shadow-root.

  it('resolves the page node identity from type.name and wraps its children in a #shadow-root', () => {
    const innerView = makeInstance('view', {})
    const instance = {
      type: { name: 'pages/index/index' },
      props: {},
      subTree: { children: [{ component: innerView }] },
    }
    createMockIframe(instance)

    const tree = extract()!
    expect(tree.tagName).toBe('pages/index/index')
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0].tagName).toBe('#shadow-root')
    expect(tree.children[0].children).toHaveLength(1)
    expect(tree.children[0].children[0].tagName).toBe('view')
  })

  it('strips a leading slash from a page path (both forms occur at runtime)', () => {
    const withSlash = { type: { name: '/pages/index/index' }, props: {}, subTree: { children: [] } }
    createMockIframe(withSlash)
    expect(extract()!.tagName).toBe('pages/index/index')
  })

  it('does NOT treat a node that INHERITED provides.path as a page or component', () => {
    // A descendant inherits its ancestor's provides.path (Vue Object.create
    // chain), so its provided path EQUALS its parent's — it is neither a page
    // (no __page__) nor a native-component boundary (path didn't change here).
    // It must not be named the page path nor `page`.
    const instance = {
      type: {
        __scopeId: 'data-v-child',
        components: { 'dd-something': {} },
      },
      props: {},
      // Inherited page path + no __page__; the parent provides the SAME path,
      // so this is an ordinary descendant, not a component boundary.
      provides: { path: '/pages/index/index' },
      parent: { provides: { path: '/pages/index/index' } },
      subTree: { children: [] },
    }
    createMockIframe(instance)

    const tree = extract()!
    expect(tree.tagName).not.toBe('pages/index/index')
    expect(tree.tagName).not.toBe('page')
  })

  it('a Taro template wrapper (dd-tpl-*) under a page is transparent, not a second page', () => {
    // 真机（Taro 小程序）实证：页面之下挂着编译产物 template 包装器
    // dd-tpl-taro_tmpl / dd-tpl-tmpl_0_3，它们 nameless，只能靠父级/appContext
    // 的组件注册表反查回注册名。它们必须透传 children，绝不能各自再生成一个
    // `page` 或路径节点。
    const templateType = { __scopeId: 'data-v-page', components: {} }
    const leaf = makeInstance('view', { class: 'card' })
    const templateWrapper = {
      type: templateType,
      props: { data: {} },
      appContext: { components: { 'dd-tpl-taro_tmpl': templateType } },
      subTree: { children: [{ component: leaf }] },
    }
    const page = {
      type: { name: 'pages/index/index' },
      props: {},
      subTree: { children: [{ component: templateWrapper }] },
    }
    createMockIframe(page)

    const tree = extract()!
    expect(tree.tagName).toBe('pages/index/index')
    // exactly one page root; the template wrapper is dropped, its leaf hoisted
    // through the page's #shadow-root.
    const shadow = tree.children.find((c) => c.tagName === '#shadow-root')!
    expect(shadow).toBeDefined()
    expect(shadow.children.map((c) => c.tagName)).toEqual(['view'])
    expect(countNodesByTag(tree, 'page')).toBe(0)
  })

  it('renders a native custom component as its full path wrapped in a #shadow-root', () => {
    // A native dimina custom component's `type.name` IS its own path. It
    // surfaces as a node tagged with that full path and wraps its rendered
    // content in a synthetic #shadow-root — matching WeChat, which shows each
    // custom component as a path-named node with an open shadow root.
    const leaf = makeInstance('view', { class: 'inner' })
    const component = {
      type: { name: '/components/comp/comp' },
      props: {},
      subTree: { children: [{ component: leaf }] },
    }
    createMockIframe(component)

    const tree = extract()!
    expect(tree.tagName).toBe('components/comp/comp')
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0].tagName).toBe('#shadow-root')
    expect(tree.children[0].children.map((c) => c.tagName)).toEqual(['view'])
  })

  it('a nameless __scopeId component with no recoverable registration falls back to `template`', () => {
    const instance = {
      type: {
        __scopeId: 'data-v-abc',
        components: { 'dd-something': {} },
      },
      props: {},
      // 没有 proxy.__page__，也无从 parent/app 反查到注册名
      subTree: { children: [] },
    }
    createMockIframe(instance)

    const tree = extract()!
    expect(tree.tagName).toBe('template')
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

    const tree = extract()!
    // PascalCase 'View' should map to 'view'. Currently the code only
    // strips a leading 'Dd' prefix; bare PascalCase falls through.
    expect(tree.tagName).toBe('view')
  })
})

// ── createWxmlSource — MiniappSnapshotSource lifecycle ──────────────────
//
// Reframes the former `setupWxmlObserver` install-lifecycle suite. The
// migration turns the WXML instrumentation into a `MiniappSnapshotSource`, so
// instead of asserting on `ipcRenderer.sendToHost('simulator:wxml', …)` these
// tests assert on the source's contract — `id`, `snapshot()`, the `emit`
// callback handed to `start()`, and `dispose()`. The source no longer touches
// IPC; the `miniappSnapshot` host owns publishing.
describe('createWxmlSource', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    disposeSource = null
  })

  afterEach(() => {
    disposeSource?.()
    cleanupIframes()
    vi.useRealTimers()
  })

  it('has id "wxml"', () => {
    const src = createWxmlSource()
    expect(src.id).toBe('wxml')
  })

  it('computes the tree synchronously and emits once when an iframe with app is already present', () => {
    // Reframes "sends tree immediately when iframe with app is already
    // present". Previously: setupWxmlObserver() emitted (Wxml, null) then the
    // real tree. Now: start() with a mounted page present must compute the
    // tree synchronously, store it, and call emit() — and snapshot() returns
    // the expected `tagName:'page'` tree.
    const instance = makeInstance('page')
    createMockIframe(instance)

    const src = createWxmlSource()
    disposeSource = () => src.dispose()
    const emit = vi.fn()
    src.start(emit)

    expect(emit).toHaveBeenCalled()
    expect(src.snapshot()).toEqual(
      expect.objectContaining({ tagName: 'page' }),
    )
  })

  it('snapshot() is null at start() time with no iframe, then resolves via the retry timer', () => {
    // Reframes "retries via interval when iframe is not yet present".
    // Previously: setupWxmlObserver() emitted exactly one (Wxml, null) and
    // then a later (Wxml, page) once an iframe appeared during the retry
    // interval. Now: snapshot() is null until a page mounts, and the
    // retry-attach machinery drives emit()+snapshot() once one does.
    const src = createWxmlSource()
    disposeSource = () => src.dispose()
    const emit = vi.fn()
    src.start(emit)

    // No iframe yet → no tree.
    expect(src.snapshot()).toBeNull()

    // Add an iframe with a Vue app and advance past the 500ms retry interval.
    const instance = makeInstance('page')
    createMockIframe(instance)
    vi.advanceTimersByTime(500)

    expect(emit).toHaveBeenCalled()
    expect(src.snapshot()).toEqual(
      expect.objectContaining({ tagName: 'page' }),
    )
  })

  it('re-emits and updates snapshot() after a DOM mutation (debounced)', async () => {
    // New-surface coverage of the MutationObserver path: a mutation inside the
    // observed page must, after the debounce window, recompute the tree, store
    // it, and call emit() again with the new tree visible via snapshot().
    const instance = makeInstance('page')
    const iframe = createMockIframe(instance)

    const src = createWxmlSource()
    disposeSource = () => src.dispose()
    const emit = vi.fn()
    src.start(emit)

    const callsAfterStart = emit.mock.calls.length
    expect(src.snapshot()).toEqual(expect.objectContaining({ tagName: 'page' }))

    // Swap in a new tree, mutate the observed page's DOM, then let the
    // debounce window elapse. jsdom delivers MutationObserver records on the
    // microtask queue, so the async timer-advance is required to flush that
    // queue before the debounce setTimeout fires.
    mountVueAppOnIframe(iframe, makeInstance('view', { class: 'next' }))
    iframe.contentDocument!.body.appendChild(
      iframe.contentDocument!.createElement('div'),
    )
    await vi.advanceTimersByTimeAsync(300)

    expect(emit.mock.calls.length).toBeGreaterThan(callsAfterStart)
    expect(src.snapshot()).toEqual(
      expect.objectContaining({ tagName: 'view', attrs: { class: 'next' } }),
    )
  })

  it('dispose() tears down observers so later mutations do not call emit', () => {
    // After dispose(), the MutationObserver / timers are gone, so a further
    // DOM mutation must NOT trigger emit() again.
    const instance = makeInstance('page')
    const iframe = createMockIframe(instance)

    const src = createWxmlSource()
    const emit = vi.fn()
    src.start(emit)
    src.dispose()
    disposeSource = null

    const callsBeforeMutation = emit.mock.calls.length

    // A mutation after disposal must not re-trigger emit().
    iframe.contentDocument!.body.appendChild(
      iframe.contentDocument!.createElement('div'),
    )
    vi.advanceTimersByTime(300)

    expect(emit.mock.calls.length).toBe(callsBeforeMutation)
  })

  // C16 (install emits a tree-clear `(simulator:wxml, null)`) was deleted:
  // install-time emit is now the framework host's responsibility — covered by
  // `src/preload/miniapp-snapshot/host.test.ts`.
})
