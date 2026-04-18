import { SimulatorChannel } from '../../shared/ipc-channels.js'
import { sendToHost } from '../runtime/host.js'
import {
  clearWxmlSnapshot,
  setWxmlSnapshot,
  type WxmlNode,
  unhighlightElement,
} from '../runtime/bridge.js'
import {
  WXML_DEBOUNCE_MS,
  WXML_RETRY_INTERVAL_MS,
  WXML_RETRY_TIMEOUT_MS,
  NAVIGATION_POLL_INTERVAL_MS,
  NAVIGATION_TIMEOUT_MS,
} from '../shared/constants.js'
import { createDisposableSet } from './disposable.js'
import { walkInstance, type ComponentInstance } from './wxml-extract.js'

function findActivePageIframe(): HTMLIFrameElement | null {
  const iframes = document.querySelectorAll<HTMLIFrameElement>('.dimina-native-webview__window')
  return iframes.length > 0 ? iframes[iframes.length - 1]! : null
}

function getVueAppFromIframe(iframe: HTMLIFrameElement): ComponentInstance | null {
  try {
    const doc = iframe.contentDocument
    if (!doc?.body) return null
    const body = doc.body as unknown as Record<string, unknown>
    const app = body.__vue_app__ as Record<string, unknown> | undefined
    if (!app) return null
    if (app._instance) return app._instance as ComponentInstance
    const container = app._container as Record<string, unknown> | undefined
    const vnode = container?._vnode as Record<string, unknown> | undefined
    return vnode?.component as ComponentInstance | null ?? null
  } catch {
    return null
  }
}

let wxmlTimer: ReturnType<typeof setTimeout> | undefined
let currentObserver: MutationObserver | null = null
let currentIframe: HTMLIFrameElement | null = null
let topObserver: MutationObserver | null = null
let retryTimer: ReturnType<typeof setInterval> | undefined
let retryTimeout: ReturnType<typeof setTimeout> | undefined
let navigationWaitTimer: ReturnType<typeof setInterval> | undefined
let navigationWaitTimeout: ReturnType<typeof setTimeout> | undefined

const disposables = createDisposableSet()

function clearTimers(): void {
  if (wxmlTimer) clearTimeout(wxmlTimer)
  if (retryTimer) clearInterval(retryTimer)
  if (retryTimeout) clearTimeout(retryTimeout)
  if (navigationWaitTimer) clearInterval(navigationWaitTimer)
  if (navigationWaitTimeout) clearTimeout(navigationWaitTimeout)
  wxmlTimer = undefined
  retryTimer = undefined
  retryTimeout = undefined
  navigationWaitTimer = undefined
  navigationWaitTimeout = undefined
}

function publishTree(tree: WxmlNode | WxmlNode[] | null): void {
  if (tree) {
    const normalized: WxmlNode = Array.isArray(tree)
      ? { tagName: '#fragment', attrs: {}, children: tree }
      : tree
    setWxmlSnapshot(normalized, true)
    sendToHost(SimulatorChannel.Wxml, normalized)
    return
  }
  clearWxmlSnapshot()
  unhighlightElement()
}

function sendWxmlTree(): void {
  const iframe = findActivePageIframe()
  if (!iframe) {
    publishTree(null)
    return
  }
  const instance = getVueAppFromIframe(iframe)
  if (!instance) {
    publishTree(null)
    return
  }
  const tree = walkInstance(instance, 0)
  if (!tree) {
    publishTree(null)
    return
  }
  publishTree(tree)
}

function observeIframe(iframe: HTMLIFrameElement): void {
  if (iframe === currentIframe) return
  if (currentObserver) {
    currentObserver.disconnect()
    currentObserver = null
  }
  if (navigationWaitTimer) {
    clearInterval(navigationWaitTimer)
    navigationWaitTimer = undefined
  }
  if (navigationWaitTimeout) {
    clearTimeout(navigationWaitTimeout)
    navigationWaitTimeout = undefined
  }
  currentIframe = iframe

  const doc = iframe.contentDocument
  if (!doc?.body) {
    publishTree(null)
    return
  }

  sendWxmlTree()
  currentObserver = new MutationObserver(() => {
    clearTimeout(wxmlTimer)
    wxmlTimer = setTimeout(sendWxmlTree, WXML_DEBOUNCE_MS)
  })
  currentObserver.observe(doc.body, { childList: true, subtree: true })
}

function tryAttach(): boolean {
  const iframe = findActivePageIframe()
  if (!iframe) return false
  const instance = getVueAppFromIframe(iframe)
  if (!instance) return false
  observeIframe(iframe)
  return true
}

function scheduleAttach(): void {
  if (retryTimer) clearInterval(retryTimer)
  if (retryTimeout) clearTimeout(retryTimeout)
  retryTimer = setInterval(() => {
    if (tryAttach() && retryTimer) {
      clearInterval(retryTimer)
      retryTimer = undefined
    }
  }, WXML_RETRY_INTERVAL_MS)
  retryTimeout = setTimeout(() => {
    if (retryTimer) clearInterval(retryTimer)
    retryTimer = undefined
  }, WXML_RETRY_TIMEOUT_MS)
}

function observeTopLevel(): void {
  if (topObserver) return
  topObserver = new MutationObserver(() => {
    const iframe = findActivePageIframe()
    if (!iframe) {
      publishTree(null)
      return
    }
    if (iframe !== currentIframe) {
      if (navigationWaitTimer) {
        clearInterval(navigationWaitTimer)
        navigationWaitTimer = undefined
      }
      if (navigationWaitTimeout) {
        clearTimeout(navigationWaitTimeout)
        navigationWaitTimeout = undefined
      }
      navigationWaitTimer = setInterval(() => {
        if (getVueAppFromIframe(iframe)) {
          if (navigationWaitTimer) {
            clearInterval(navigationWaitTimer)
            navigationWaitTimer = undefined
          }
          if (navigationWaitTimeout) {
            clearTimeout(navigationWaitTimeout)
            navigationWaitTimeout = undefined
          }
          observeIframe(iframe)
        }
      }, NAVIGATION_POLL_INTERVAL_MS)
      navigationWaitTimeout = setTimeout(() => {
        if (navigationWaitTimer) {
          clearInterval(navigationWaitTimer)
          navigationWaitTimer = undefined
        }
        navigationWaitTimeout = undefined
      }, NAVIGATION_TIMEOUT_MS)
    }
  })

  if (document.body) {
    topObserver.observe(document.body, { childList: true, subtree: true })
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      if (document.body && topObserver) {
        topObserver.observe(document.body, { childList: true, subtree: true })
      }
    }, { once: true })
  }
}

export function installWxmlInstrumentation(): () => void {
  if (!tryAttach()) {
    scheduleAttach()
  }
  observeTopLevel()

  disposables.add(() => {
    if (currentObserver) {
      currentObserver.disconnect()
      currentObserver = null
    }
  })
  disposables.add(() => {
    if (topObserver) {
      topObserver.disconnect()
      topObserver = null
    }
  })
  disposables.add(() => {
    currentIframe = null
    clearTimers()
  })
  disposables.add(() => {
    clearWxmlSnapshot()
    unhighlightElement()
  })

  return () => {
    disposables.disposeAll()
  }
}

export const setupWxmlObserver = installWxmlInstrumentation
export { sendWxmlTree }
