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
import type { MiniappSnapshotSource } from '../miniapp-snapshot/types.js'
import { walkInstance, type ComponentInstance } from './wxml-extract.js'
import { getActivePageIframe } from '../shared/page-iframe.js'

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

/** Compute the normalized WXML tree for the currently-active page, or `null`. */
function computeWxmlTree(): WxmlNode | null {
  const iframe = getActivePageIframe()
  if (!iframe) return null
  const instance = getVueAppFromIframe(iframe)
  if (!instance) return null
  const tree = walkInstance(instance, 0)
  if (!tree) return null
  return Array.isArray(tree)
    ? { tagName: '#fragment', attrs: {}, children: tree }
    : tree
}

/**
 * The WXML snapshot data source.
 *
 * Observes the simulator page's Vue tree (retry-attach + MutationObserver +
 * top-level navigation observer), recomputes a normalized {@link WxmlNode}
 * tree on every (debounced) change, stores it internally, and calls `emit()`
 * so the `miniappSnapshot` host publishes it. The source itself never touches
 * IPC — the host owns the push/pull transport and the install-time publish.
 *
 * It keeps the `__simulatorData.getWxml()` automation surface working by
 * mirroring each computed tree into the simulator bridge via
 * `setWxmlSnapshot` / `clearWxmlSnapshot`.
 */
export function createWxmlSource(): MiniappSnapshotSource<WxmlNode | null> {
  let tree: WxmlNode | null = null
  let emit: (() => void) | null = null

  let wxmlTimer: ReturnType<typeof setTimeout> | undefined
  let currentObserver: MutationObserver | null = null
  let currentIframe: HTMLIFrameElement | null = null
  let topObserver: MutationObserver | null = null
  let retryTimer: ReturnType<typeof setInterval> | undefined
  let retryTimeout: ReturnType<typeof setTimeout> | undefined
  let navigationWaitTimer: ReturnType<typeof setInterval> | undefined
  let navigationWaitTimeout: ReturnType<typeof setTimeout> | undefined

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

  /**
   * Recompute the tree, store it, mirror it to the automation bridge, and
   * notify the host. The single update path shared by attach, navigation and
   * MutationObserver callbacks.
   */
  function refresh(): void {
    tree = computeWxmlTree()
    if (tree) {
      setWxmlSnapshot(tree, true)
    } else {
      clearWxmlSnapshot()
      unhighlightElement()
    }
    emit?.()
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
      refresh()
      return
    }

    refresh()
    currentObserver = new MutationObserver(() => {
      clearTimeout(wxmlTimer)
      wxmlTimer = setTimeout(refresh, WXML_DEBOUNCE_MS)
    })
    currentObserver.observe(doc.body, { childList: true, subtree: true })
  }

  function tryAttach(): boolean {
    const iframe = getActivePageIframe()
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
      const iframe = getActivePageIframe()
      if (!iframe) {
        refresh()
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

  return {
    id: 'wxml',
    snapshot: () => tree,
    start(onChange) {
      emit = onChange
      // If a page with a mounted Vue app is already present, observeIframe()
      // computes & stores the tree synchronously and emits once. Otherwise the
      // retry timer drives the first emit once a page mounts.
      if (!tryAttach()) {
        scheduleAttach()
      }
      observeTopLevel()
    },
    dispose() {
      if (currentObserver) {
        currentObserver.disconnect()
        currentObserver = null
      }
      if (topObserver) {
        topObserver.disconnect()
        topObserver = null
      }
      currentIframe = null
      clearTimers()
      clearWxmlSnapshot()
      unhighlightElement()
      tree = null
      emit = null
    },
  }
}
