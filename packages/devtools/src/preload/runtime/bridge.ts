import { contextBridge } from 'electron'

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
    'transition:all 0.1s ease;display:none;border-radius:2px;'
  doc.body.appendChild(highlightOverlay)
  return highlightOverlay
}

function highlightElement(sid: string): void {
  const iframe = getPageIframe()
  if (!iframe?.contentDocument) return
  const doc = iframe.contentDocument
  const el = Array.from(doc.querySelectorAll<HTMLElement>('[data-sid], [data-dimina-devtools-sid]'))
    .find((node) =>
      node.getAttribute('data-sid') === sid || node.getAttribute('data-dimina-devtools-sid') === sid
    ) ?? null
  if (!el) return
  const rect = el.getBoundingClientRect()
  const overlay = ensureOverlay(doc)
  overlay.style.left = `${rect.left}px`
  overlay.style.top = `${rect.top}px`
  overlay.style.width = `${rect.width}px`
  overlay.style.height = `${rect.height}px`
  overlay.style.display = 'block'
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
