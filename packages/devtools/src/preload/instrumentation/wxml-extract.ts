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

function resolveTagName(instance: ComponentInstance): string {
  const type = instance.type
  if (!type) return 'unknown'
  if (typeof type.__tagName === 'string') return type.__tagName
  const name = (type.__name || type.name) as string | undefined
  if (!name) {
    if (type.__scopeId && type.components) return 'page'
    if (type.__scopeId) return resolveTemplateNameFromParent(instance) || 'template'
    return 'unknown'
  }
  if (name === 'dd-page') return 'page'
  if (name.startsWith('dd-')) return name.slice(3)
  if (name.startsWith('Dd') && name.length > 2) return name.slice(2).toLowerCase()
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

function extractChildrenFromVNode(vnode: Record<string, unknown> | null | undefined, depth: number): WxmlNode[] {
  if (!vnode || depth > 50) return []
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

export function walkInstance(instance: ComponentInstance, depth: number): WxmlNode | WxmlNode[] | null {
  if (depth > 50) return null
  const tagName = resolveTagName(instance)
  const children = extractChildrenFromVNode(instance.subTree as Record<string, unknown>, depth)
  if (isTransparentComponent(instance, tagName)) return children.length > 0 ? children : null
  const node: WxmlNode = { tagName, attrs: extractProps(instance), children }
  const sid = getElementSid(instance)
  if (sid) node.sid = sid
  return node
}
