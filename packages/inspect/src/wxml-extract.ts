import { registerSyntheticSid } from './sid-registry.js'
import type { WxmlNode } from './types.js'

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

/**
 * Strip the `dd-` registration prefix and the `tpl-` prefix dimina adds to
 * compiled template components (`app.component('dd-tpl-taro_tmpl', …)`), so a
 * framework template wrapper normalizes to its bare name (`taro_tmpl`,
 * `tmpl_0_3`) and `FRAMEWORK_TEMPLATE_RE` recognizes it.
 */
function normalizeRegisteredName(regName: string): string {
  const base = regName.startsWith('dd-') ? regName.slice(3) : regName
  return base.startsWith('tpl-') ? base.slice(4) : base
}

function resolveTemplateNameFromParent(instance: ComponentInstance): string | null {
  const parent = instance.parent as Record<string, unknown> | undefined
  const parentType = parent?.type as Record<string, unknown> | undefined
  const components = parentType?.components as Record<string, unknown> | undefined
  if (components) {
    for (const [regName, comp] of Object.entries(components)) {
      if (comp === instance.type) return normalizeRegisteredName(regName)
    }
  }
  const appComponents = instance.appContext?.components as Record<string, unknown> | undefined
  if (!appComponents) return null
  for (const [regName, comp] of Object.entries(appComponents)) {
    if (comp === instance.type) return normalizeRegisteredName(regName)
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

export function resolveTagName(instance: ComponentInstance): string {
  const type = instance.type
  if (!type) return 'unknown'
  // Authoritative source-path identity: the render runtime sets each compiled
  // page/custom-component's Vue `name` to its miniprogram module path. A name
  // containing `/` IS that source path — trust it directly (WeChat parity).
  // It is per-type (not inherited via provides), so a descendant never leaks its
  // ancestor's path, and it needs no live provide/inject chain to reconstruct.
  const nameId = (type.name || type.__name) as string | undefined
  if (nameId && nameId.includes('/')) {
    return nameId.startsWith('/') ? nameId.slice(1) : nameId
  }
  if (typeof type.__tagName === 'string') return type.__tagName
  const name = (type.__name || type.name) as string | undefined
  if (!name) {
    // A nameless component carrying a `__scopeId` is a framework template
    // wrapper (e.g. a Taro `taro_tmpl`/`tmpl_0_3`) — pages and custom components
    // carry a path `name` and are resolved above. Recover the registered tag and
    // fall back to `template`; never default to `page` here, which would
    // mislabel every such wrapper as a second page root.
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

/** Props/attrs entries that never surface in the WXML panel (internal Vue plumbing, falsy booleans). */
function isSkippedProp(key: string, value: unknown): boolean {
  if (typeof value === 'function' || value === undefined) return true
  if (key === 'data' || key.startsWith('__')) return true
  return typeof value === 'boolean' && !value
}

/** Drop the `dd-` internal-marker classes so the panel shows only user-authored classes. */
function cleanClassAttr(value: string): string {
  return value.split(/\s+/).filter((c) => !c.startsWith('dd-')).join(' ')
}

function stringifyPropValue(value: unknown): string {
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function assignProp(out: Record<string, string>, key: string, value: unknown): void {
  if (isSkippedProp(key, value)) return
  if (key === 'class' && typeof value === 'string') {
    const cleaned = cleanClassAttr(value)
    if (cleaned) out[key] = cleaned
    return
  }
  out[key] = stringifyPropValue(value)
}

function extractProps(instance: ComponentInstance): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of [instance.props, instance.attrs]) {
    if (!raw) continue
    for (const [k, v] of Object.entries(raw)) {
      assignProp(out, k, v)
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
  if (!el?.getAttribute) return undefined
  const sid = el.getAttribute('data-sid')
  if (sid) return sid
  return registerSyntheticSid(el)
}

function isTransparentComponent(instance: ComponentInstance, tagName: string): boolean {
  if (tagName === 'unknown') return true
  // A framework template wrapper (Taro `taro_tmpl` / `tmpl_0_3`, whether named
  // via `props.is` or recovered from its registration) is compiler scaffolding,
  // not user content — pass its children straight through.
  if (FRAMEWORK_TEMPLATE_RE.test(tagName)) return true
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

function textNode(text: string): WxmlNode {
  return { tagName: '#text', attrs: {}, children: [], text }
}

/** A component vnode's children come from walking its mounted instance, not `vnode.children`. */
function childrenFromComponentVNode(component: ComponentInstance, depth: number): WxmlNode[] {
  const result = walkInstance(component, depth + 1)
  if (!result) return []
  return Array.isArray(result) ? result : [result]
}

/** A `<Suspense>` vnode's visible content is whichever branch is currently active. */
function childrenFromSuspenseVNode(suspense: Record<string, unknown>, depth: number): WxmlNode[] {
  const activeBranch = suspense.activeBranch as Record<string, unknown> | null
  return activeBranch ? extractChildrenFromVNode(activeBranch, depth + 1) : []
}

/**
 * A vnode whose OWN `children` is a plain string only counts as a text node when
 * its `type` is a symbol/string (a real element or fragment) — a component vnode
 * with string `children` is slot content, not text, and is handled elsewhere.
 * Returns null when this vnode is not (top-level) text, so the caller falls
 * through to the array-children path.
 */
function directTextChild(vnode: Record<string, unknown>): WxmlNode[] | null {
  if (typeof vnode.children !== 'string' || !vnode.children.trim()) return null
  const vnodeType = vnode.type
  if (typeof vnodeType !== 'symbol' && typeof vnodeType !== 'string') return null
  return [textNode(vnode.children.trim())]
}

function textChildEntry(child: string): WxmlNode[] {
  const trimmed = child.trim()
  return trimmed ? [textNode(trimmed)] : []
}

/** A DOM-typed child (`type` is its tag name string): text leaf, internal wrapper, or a normal subtree. */
function domTypedChildEntries(c: Record<string, unknown>, depth: number): WxmlNode[] {
  if (isInternalElement(c)) return extractChildrenFromVNode(c, depth + 1)
  if (typeof c.children === 'string' && c.children.trim()) return [textNode(c.children.trim())]
  return extractChildrenFromVNode(c, depth + 1)
}

/** One entry from a vnode's `children` array, normalized to zero or more WXML nodes. */
function extractChildEntry(child: unknown, depth: number): WxmlNode[] {
  if (!child) return []
  if (typeof child === 'string') return textChildEntry(child)
  if (typeof child !== 'object') return []
  const c = child as Record<string, unknown>
  if (c.component) return childrenFromComponentVNode(c.component as ComponentInstance, depth)
  if (typeof c.type === 'symbol') return extractChildrenFromVNode(c, depth + 1)
  if (typeof c.type === 'string') return domTypedChildEntries(c, depth)
  return extractChildrenFromVNode(c, depth + 1)
}

function extractChildrenFromVNode(vnode: Record<string, unknown> | null | undefined, depth: number): WxmlNode[] {
  if (!vnode || depth > 50) return []
  if (isCommentVNode(vnode)) return []
  if (vnode.component) return childrenFromComponentVNode(vnode.component as ComponentInstance, depth)
  if (vnode.suspense) return childrenFromSuspenseVNode(vnode.suspense as Record<string, unknown>, depth)
  const directText = directTextChild(vnode)
  if (directText) return directText
  const kids = vnode.children
  if (!Array.isArray(kids)) return []
  const result: WxmlNode[] = []
  for (const child of kids) {
    result.push(...extractChildEntry(child, depth))
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
