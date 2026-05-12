import { contextBridge } from 'electron'
import type { ElementInspection } from '../../shared/ipc-channels.js'

export interface WxmlNode {
  tagName: string
  attrs: Record<string, string>
  children: WxmlNode[]
  text?: string
  sid?: string
}

export interface Snapshot<T> {
  gen: number
  ready: boolean
  data: T
}

export interface StorageSnapshot extends Snapshot<Record<string, string>> {
  namespace: string | null
}

type RefreshTarget = 'wxml' | 'appdata' | 'storage'

interface SimulatorBridgeState {
  appdata: Snapshot<Record<string, unknown>>
  storage: StorageSnapshot
  wxml: Snapshot<WxmlNode | WxmlNode[] | null>
  refreshHandler: ((type: RefreshTarget) => void) | null
}

const state: SimulatorBridgeState = {
  appdata: { gen: 0, ready: true, data: {} },
  storage: { gen: 0, ready: false, namespace: null, data: {} },
  wxml: { gen: 0, ready: false, data: null },
  refreshHandler: null,
}

let highlightOverlay: HTMLDivElement | null = null
let exposedApi: Record<string, unknown> | null = null

// 合成 sid 注册表：用 WeakMap 把元素 ↔ sid 双向绑定，避免在源 DOM 上写
// `data-*` 属性（提取本应只读，且属性形式会污染用户的快照/选择器）。
// elBySyntheticSid 为反向查找用 WeakRef，元素被 GC 后下次 lookup 自动清理。
const SYNTHETIC_SID_PREFIX = 'devtools-'
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

function findElementBySid(doc: Document, sid: string): HTMLElement | null {
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
  return doc.querySelector(`[data-sid="${CSS.escape(sid)}"]`) as HTMLElement | null
}

function clone<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    return value
  }
}

function getPageIframe(): HTMLIFrameElement | null {
  const iframes = document.querySelectorAll<HTMLIFrameElement>('.dimina-native-webview__window')
  return iframes.length > 0 ? iframes[iframes.length - 1]! : null
}

function ensureOverlay(doc: Document): HTMLDivElement {
  if (highlightOverlay && highlightOverlay.ownerDocument === doc) return highlightOverlay
  highlightOverlay = doc.createElement('div')
  highlightOverlay.id = '__simulator-highlight'
  highlightOverlay.style.cssText =
    'position:fixed;pointer-events:none;z-index:999999;' +
    'border:2px solid #1a73e8;background:rgba(26,115,232,0.12);' +
    'transition:all 0.1s ease;display:none;border-radius:2px;box-sizing:border-box;'
  doc.body.appendChild(highlightOverlay)
  return highlightOverlay
}

function highlightElement(sid: string): ElementInspection | null {
  if (!sid) return null
  const iframe = getPageIframe()
  if (!iframe?.contentDocument) return null
  const doc = iframe.contentDocument
  const el = findElementBySid(doc, sid)
  if (!el) return null
  const rect = el.getBoundingClientRect()
  const overlay = ensureOverlay(doc)
  overlay.style.left = `${rect.left}px`
  overlay.style.top = `${rect.top}px`
  overlay.style.width = `${rect.width}px`
  overlay.style.height = `${rect.height}px`
  overlay.style.display = 'block'
  const style = el.ownerDocument.defaultView?.getComputedStyle(el)
  if (!style) return null
  return {
    sid,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    style: {
      display: style.display,
      position: style.position,
      boxSizing: style.boxSizing,
      margin: style.margin,
      padding: style.padding,
      color: style.color,
      backgroundColor: style.backgroundColor,
      fontSize: style.fontSize,
    },
  }
}

function unhighlightElement(): void {
  if (highlightOverlay) highlightOverlay.style.display = 'none'
}

export { highlightElement, unhighlightElement }

function buildApi(): Record<string, unknown> {
  return {
    getAppdata: () => clone(state.appdata.data),
    getAppdataSnapshot: () => clone(state.appdata),
    getAppdataGen: () => state.appdata.gen,
    getStorageSnapshot: () => clone(state.storage),
    getStorageGen: () => state.storage.gen,
    getWxml: () => clone(state.wxml.data),
    getWxmlSnapshot: () => clone(state.wxml),
    getWxmlGen: () => state.wxml.gen,
    refresh: (type: RefreshTarget) => state.refreshHandler?.(type),
    highlightElement,
    unhighlightElement,
  }
}

export const simulatorBridge = state

export function setRefreshHandler(handler: ((type: RefreshTarget) => void) | null): void {
  state.refreshHandler = handler
}

export function setAppDataSnapshot(data: Record<string, unknown>): void {
  state.appdata = {
    gen: state.appdata.gen + 1,
    ready: true,
    data: clone(data),
  }
}

export function clearAppDataSnapshot(): void {
  state.appdata = {
    gen: state.appdata.gen + 1,
    ready: true,
    data: {},
  }
}

export function setStorageSnapshot(namespace: string | null, data: Record<string, string>): void {
  state.storage = {
    gen: state.storage.gen + 1,
    ready: namespace !== null,
    namespace,
    data: clone(data),
  }
}

export function clearStorageSnapshot(): void {
  state.storage = {
    gen: state.storage.gen + 1,
    ready: false,
    namespace: null,
    data: {},
  }
}

export function setWxmlSnapshot(data: WxmlNode | WxmlNode[] | null, ready = true): void {
  state.wxml = {
    gen: state.wxml.gen + 1,
    ready,
    data: clone(data),
  }
}

export function clearWxmlSnapshot(): void {
  state.wxml = {
    gen: state.wxml.gen + 1,
    ready: false,
    data: null,
  }
}

export function resetBridgeState(): void {
  clearAppDataSnapshot()
  clearStorageSnapshot()
  clearWxmlSnapshot()
  unhighlightElement()
  state.refreshHandler = null
}

export function installSimulatorBridge(): () => void {
  if (!exposedApi) {
    exposedApi = buildApi()
  }

  try {
    contextBridge.exposeInMainWorld('__simulatorData', {
      ...exposedApi,
      getAppdata: () => clone(state.appdata.data),
      getAppdataSnapshot: () => clone(state.appdata),
      getStorageSnapshot: () => clone(state.storage),
      getWxml: () => clone(state.wxml.data),
      getWxmlSnapshot: () => clone(state.wxml),
    })
  } catch {
    ;(window as unknown as Record<string, unknown>).__simulatorData = exposedApi
  }

  return () => {
    resetBridgeState()
    const windowRef = window as unknown as Record<string, unknown>
    if (windowRef.__simulatorData === exposedApi) {
      delete windowRef.__simulatorData
    }
  }
}
