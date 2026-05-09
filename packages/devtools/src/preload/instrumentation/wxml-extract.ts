import { type WxmlNode } from '../runtime/bridge.js'

export interface ComponentInstance extends Record<string, unknown> {
  type?: Record<string, unknown>
  props?: Record<string, unknown>
  attrs?: Record<string, unknown>
  parent?: Record<string, unknown>
  appContext?: Record<string, unknown>
  subTree?: Record<string, unknown>
}

const INTERNAL_CLASSES = new Set([
  'dd-swiper-wrapper', 'dd-swiper-slides', 'dd-swiper-slide-frame', 'dd-swiper-dots',
  'dd-picker-overlay', 'dd-picker-container', 'dd-picker-header', 'dd-picker-body',
])

const FRAMEWORK_TEMPLATE_RE = /^(taro_tmpl|tmpl_\d+)/

function resolveTemplateNameFromParent(instance: ComponentInstance): string | null {
  const parent = instance.parent as Record<string, unknown> | undefined
  if (!parent) return null
  const parentType = parent.type as Record<string, unknown> | undefined
  const components = parentType?.components as Record<string, unknown> | undefined
  if (components) {
    for (const [regName, comp] of Object.entries(components)) {
      if (comp === instance.type) return regName.startsWith('dd-') ? regName.slice(3) : regName
    }
  }
  const appComponents = instance.appContext?.components as Record<string, unknown> | undefined
  if (!appComponents) return null
  for (const [regName, comp] of Object.entries(appComponents)) {
    if (comp === instance.type) return regName.startsWith('dd-') ? regName.slice(3) : regName
  }
  return null
}

/**
 * Convert a PascalCase / camelCase identifier to kebab-case. Matches the
 * upstream `camelCaseToUnderscore` (dimina/fe/packages/common) so a name
 * already normalized by `withInstall` round-trips identically.
 * `View` -> `view`, `ScrollView` -> `scroll-view`, `CoverImage` -> `cover-image`.
 */
function pascalToKebab(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
}

/**
 * Read the page's source path off Vue's provide/inject. dimina runtime.js 在
 * dd-page 的 setup() 里调用 `provide('path', path)`，Vue 把它存到
 * `instance.provides`。我们利用这个把页面节点的 tagName 从硬编码 `page`
 * 升级为页面全路径（如 `pages/index/index`），对齐微信开发者工具。
 */
function resolvePagePath(instance: ComponentInstance): string | null {
  // dimina runtime 在 dd-page 的 setup 里 `instance.proxy.__page__ = true` 并
  // `provide('path', path)`。两个标记同时具备才视为页面层级，避免 dd-page
  // 的子节点继承 provides.path 后被误判（Vue 用 Object.create 链式 provides）。
  const proxy = (instance as Record<string, unknown>).proxy as
    | Record<string, unknown>
    | undefined
  if (proxy?.__page__ !== true) return null
  const provides = (instance as Record<string, unknown>).provides as
    | Record<string, unknown>
    | undefined
  const path = provides?.path
  if (typeof path !== 'string' || !path) return null
  return path.startsWith('/') ? path.slice(1) : path
}

function resolveTagName(instance: ComponentInstance): string {
  const type = instance.type
  if (!type) return 'unknown'
  // 页面层级优先：dd-page 没有 __tagName/__name，且 home 页等无 usingComponents
  // 的页面 type.components 为 undefined，会落到 resolveTemplateNameFromParent
  // 回到 'page'。在那之前直接用 provide('path') 的路径升级 tag 名。
  const pagePath = resolvePagePath(instance)
  if (pagePath) return pagePath
  if (typeof type.__tagName === 'string') return type.__tagName
  const name = (type.__name || type.name) as string | undefined
  if (!name) {
    if (type.__scopeId && type.components) return 'page'
    if (type.__scopeId) return resolveTemplateNameFromParent(instance) || 'template'
    return 'unknown'
  }
  if (name === 'dd-page') return 'page'
  if (name.startsWith('dd-')) return name.slice(3)
  // Reverse-map Dimina component names back to their miniprogram tag names.
  // The installer (`withInstall`) sets `__tagName = camelCaseToUnderscore(__name)`,
  // but in dev builds, custom registrations, or when the installer hasn't run,
  // we may only see the raw `__name`/`name` (e.g. `View`, `ScrollView`, `DdButton`).
  // Without this fallback the WXML panel would surface the upstream Vue name
  // verbatim, defeating the panel's purpose of showing source-level tags.
  if (name.startsWith('Dd') && name.length > 2) return pascalToKebab(name.slice(2))
  if (/^[A-Z]/.test(name)) return pascalToKebab(name)
  return name
}

function extractProps(instance: ComponentInstance): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of [instance.props, instance.attrs]) {
    if (!raw) continue
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'function' || v === undefined) continue
      if (k === 'data' || k.startsWith('__')) continue
      if (typeof v === 'boolean' && !v) continue
      if (k === 'class' && typeof v === 'string') {
        const cleaned = v.split(/\s+/).filter((c) => !c.startsWith('dd-')).join(' ')
        if (cleaned) out[k] = cleaned
        continue
      }
      out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v)
    }
  }
  return out
}

function isInternalElement(vnode: Record<string, unknown>): boolean {
  const props = vnode.props as Record<string, unknown> | null
  if (!props) return false
  const cls = String(props.class || '')
  return cls.split(/\s+/).some((c) => INTERNAL_CLASSES.has(c))
}

function getElementSid(instance: ComponentInstance): string | undefined {
  const subTree = instance.subTree as Record<string, unknown> | undefined
  const el = subTree?.el as HTMLElement | undefined
  return el?.getAttribute ? el.getAttribute('data-sid') ?? undefined : undefined
}

function isTransparentComponent(instance: ComponentInstance, tagName: string): boolean {
  if (tagName === 'unknown') return true
  if (tagName === 'template') {
    const props = instance.props as Record<string, unknown> | undefined
    const is = props?.is as string | undefined
    if (is && FRAMEWORK_TEMPLATE_RE.test(is)) return true
    if (!is) {
      const type = instance.type as Record<string, unknown> | undefined
      if (type?.__scopeId && !type.components) return true
    }
  }
  return false
}

/**
 * 检测 Vue 的 Comment vnode（`v-if`/`v-else`/`v-for` 占位锚点）。
 * Vue 在条件不成立时会留下 `<!-- v-if -->` 这样的注释 vnode 用作 DOM 锚点。
 * 这些 vnode 不是用户内容，必须从 wxml 树里剔除。
 *
 * - dev build：type 是 `Symbol('Comment')`，description = 'Comment' 或 'v-cmt'
 * - prod build：description 可能丢失，但 children 一般是 'v-if'/'v-else' 等 marker
 */
function isCommentVNode(vnode: Record<string, unknown>): boolean {
  const type = vnode.type
  if (typeof type !== 'symbol') return false
  const desc = type.description
  if (desc === 'Comment' || desc === 'v-cmt') return true
  const children = typeof vnode.children === 'string' ? vnode.children : ''
  return /^v-(if|else|else-if|for)$/.test(children)
}

function extractChildrenFromVNode(vnode: Record<string, unknown> | null | undefined, depth: number): WxmlNode[] {
  if (!vnode || depth > 50) return []
  if (isCommentVNode(vnode)) return []
  if (vnode.component) {
    const result = walkInstance(vnode.component as ComponentInstance, depth + 1)
    return result ? (Array.isArray(result) ? result : [result]) : []
  }
  if (vnode.suspense) {
    const suspense = vnode.suspense as Record<string, unknown>
    const activeBranch = suspense.activeBranch as Record<string, unknown> | null
    return activeBranch ? extractChildrenFromVNode(activeBranch, depth + 1) : []
  }
  if (typeof vnode.children === 'string' && vnode.children.trim()) {
    const vnodeType = vnode.type
    if (typeof vnodeType === 'symbol' || typeof vnodeType === 'string') {
      return [{ tagName: '#text', attrs: {}, children: [], text: vnode.children.trim() }]
    }
  }
  const kids = vnode.children
  if (!Array.isArray(kids)) return []
  const result: WxmlNode[] = []
  for (const child of kids) {
    if (!child) continue
    if (typeof child === 'string') {
      const trimmed = child.trim()
      if (trimmed) result.push({ tagName: '#text', attrs: {}, children: [], text: trimmed })
      continue
    }
    if (typeof child !== 'object') continue
    const c = child as Record<string, unknown>
    if (c.component) {
      const walked = walkInstance(c.component as ComponentInstance, depth + 1)
      if (walked) result.push(...(Array.isArray(walked) ? walked : [walked]))
      continue
    }
    if (typeof c.type === 'symbol') {
      result.push(...extractChildrenFromVNode(c, depth + 1))
      continue
    }
    if (typeof c.type === 'string') {
      if (isInternalElement(c)) {
        result.push(...extractChildrenFromVNode(c, depth + 1))
      } else if (typeof c.children === 'string' && c.children.trim()) {
        result.push({ tagName: '#text', attrs: {}, children: [], text: c.children.trim() })
      } else {
        result.push(...extractChildrenFromVNode(c, depth + 1))
      }
      continue
    }
    result.push(...extractChildrenFromVNode(c, depth + 1))
  }
  return result
}

/**
 * Reverse-map Dimina's `<wrapper name="/components/foo/foo">` (used to host
 * every user-defined component) back to the source-level tag the user wrote
 * in WXML (e.g. `<foo>`).
 *
 * The wrapper carries the registered component path in its `name` Vue prop.
 * By convention (also followed by miniprogram tooling), the registered key is
 * the last path segment, optionally stripping a trailing `/index`. We can't
 * see the page's `usingComponents` map from inside the Vue instance, so this
 * convention-based recovery is best-effort: if the user picked a different
 * registration key than the directory name (e.g. `usingComponents:
 * { myCounter: '/components/counter/counter' }`), the panel will show
 * `counter`, not `myCounter`.
 *
 * The path heuristic also resolves a name-collision risk: a user-written
 * `<counter name="x">` would land in the same `attrs.name` slot as the
 * wrapper-internal path. We only unwrap when the value looks like an absolute
 * component path (leading `/`), which dimina always emits but a user would
 * almost never type as a literal attr.
 */
function unwrapCustomComponent(node: WxmlNode): WxmlNode {
  if (node.tagName !== 'wrapper') return node
  const path = node.attrs?.name
  if (typeof path !== 'string' || !path.startsWith('/')) return node
  // 去掉前导 `/` 后保留原路径形式（保留所有斜杠，不做 kebab/dash 转换）。
  // 仅当路径以 `/index` 结尾且剥离后仍至少剩一段时才剥（`/index` 单独存在则
  // 退回 wrapper，避免出现空 tagName）。
  const stripped = path.replace(/^\//, '')
  const withoutIndex = stripped.endsWith('/index') ? stripped.slice(0, -'/index'.length) : stripped
  const recovered = withoutIndex || stripped
  if (!recovered || recovered === 'index') return node
  const nextAttrs: Record<string, string> = {}
  for (const [k, v] of Object.entries(node.attrs)) {
    if (k === 'name') continue
    nextAttrs[k] = v
  }
  return { ...node, tagName: recovered, attrs: nextAttrs }
}

/**
 * 把"用户授权"层级（页面 / 自定义组件，tagName 以路径形式呈现，含 `/`）
 * 的 children 包一层合成 `#shadow-root`，对齐微信开发者工具：组件本身
 * 与内部实现之间用 shadow-root 边界视觉分隔。
 *
 * 内置组件（view/text/button 等）和合成节点（#text/#fragment）tagName 都
 * 不含 `/`，自然不会被包裹。children 为空也不插入（避免空壳）。重复调用
 * 是幂等的：若 children[0] 已经是 #shadow-root 就跳过。
 */
function wrapInShadowRoot(node: WxmlNode): WxmlNode {
  if (!node.tagName.includes('/')) return node
  if (node.children.length === 0) return node
  if (node.children[0]?.tagName === '#shadow-root') return node
  return {
    ...node,
    children: [{ tagName: '#shadow-root', attrs: {}, children: node.children }],
  }
}

export function walkInstance(instance: ComponentInstance, depth: number): WxmlNode | WxmlNode[] | null {
  if (depth > 50) return null
  const tagName = resolveTagName(instance)
  const children = extractChildrenFromVNode(instance.subTree as Record<string, unknown>, depth)
  if (isTransparentComponent(instance, tagName)) return children.length > 0 ? children : null
  const node: WxmlNode = { tagName, attrs: extractProps(instance), children }
  const sid = getElementSid(instance)
  if (sid) node.sid = sid
  return wrapInShadowRoot(unwrapCustomComponent(node))
}
