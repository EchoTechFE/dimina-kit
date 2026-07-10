// Stable-id registry for WXML nodes, shared by every extractor that walks a
// render-layer document (host iframe extractors, injected guest inspectors,
// browser preview bridges). It is dependency-free so injected bundles stay
// small and don't drag in host-specific machinery.

// 合成 sid 注册表：用 WeakMap 把元素 ↔ sid 双向绑定，避免在源 DOM 上写
// `data-*` 属性（提取本应只读，且属性形式会污染用户的快照/选择器）。
// elBySyntheticSid 为反向查找用 WeakRef，元素被 GC 后下次 lookup 自动清理。
export const SYNTHETIC_SID_PREFIX = 'devtools-'
const syntheticSidByEl = new WeakMap<HTMLElement, string>()
const elBySyntheticSid = new Map<string, WeakRef<HTMLElement>>()
let nextSyntheticSid = 1

export function registerSyntheticSid(el: HTMLElement): string {
  const existing = syntheticSidByEl.get(el)
  if (existing) return existing
  const synthetic = `${SYNTHETIC_SID_PREFIX}${nextSyntheticSid++}`
  syntheticSidByEl.set(el, synthetic)
  elBySyntheticSid.set(synthetic, new WeakRef(el))
  return synthetic
}

export function findElementBySid(doc: Document, sid: string): HTMLElement | null {
  if (sid.startsWith(SYNTHETIC_SID_PREFIX)) {
    const ref = elBySyntheticSid.get(sid)
    if (!ref) return null
    const el = ref.deref()
    if (!el || !el.isConnected) {
      elBySyntheticSid.delete(sid)
      return null
    }
    if (el.ownerDocument !== doc) return null
    return el
  }
  return doc.querySelector(`[data-sid="${escapeForAttrSelector(sid)}"]`) as HTMLElement | null
}

// `CSS.escape` only exists in real browser realms (jsdom has no `window.CSS`).
// Inside a double-quoted attribute selector, escaping backslashes and quotes
// is sufficient, so fall back to that when the host lacks the API.
function escapeForAttrSelector(value: string): string {
  const impl = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape
  if (impl) return impl(value)
  return value.replace(/[\\"]/g, '\\$&')
}
