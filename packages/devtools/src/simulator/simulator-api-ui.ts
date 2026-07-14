/**
 * DevTools implementations for the WeChat-style interaction APIs that native
 * platforms (iOS / Android / Harmony) provide but the web container lacks:
 * showToast / hideToast / showLoading / hideLoading / showModal /
 * showActionSheet.
 *
 * Each handler is bound with `this` = MiniApp instance (via
 * AppManager.registerApi → MiniApp.invokeApi). The overlay is rendered by the
 * DeviceShell-resident `<UiOverlay>`; these handlers only push state into
 * `uiOverlayBus` and fire the success/fail/complete callbacks — immediately for
 * toast/loading, and on user interaction for modal/actionSheet (defaults and
 * verdict strings mirror the Android `InteractionApi`).
 */

import type { MiniAppContext } from './types'
import { bindCallbacks } from './simulator-api-helpers'
import { uiOverlayBus } from './ui-overlay-bus'

interface ToastOpts {
  title?: string
  icon?: 'success' | 'error' | 'loading' | 'none'
  image?: string
  duration?: number
  mask?: boolean
  success?: unknown
  fail?: unknown
  complete?: unknown
}

export function showToast(this: MiniAppContext, opts: ToastOpts = {}) {
  const { onSuccess, onComplete } = bindCallbacks(this, opts)
  uiOverlayBus.showToast({
    title: opts.title ?? '',
    icon: opts.icon ?? 'success',
    image: opts.image,
    duration: opts.duration ?? 1500,
    mask: opts.mask ?? false,
  })
  onSuccess?.({ errMsg: 'showToast:ok' })
  onComplete?.()
}

export function hideToast(this: MiniAppContext, opts: { success?: unknown; complete?: unknown } = {}) {
  const { onSuccess, onComplete } = bindCallbacks(this, opts)
  uiOverlayBus.hideToast()
  onSuccess?.({ errMsg: 'hideToast:ok' })
  onComplete?.()
}

export function showLoading(
  this: MiniAppContext,
  opts: { title?: string; mask?: boolean; success?: unknown; complete?: unknown } = {},
) {
  const { onSuccess, onComplete } = bindCallbacks(this, opts)
  uiOverlayBus.showToast({
    title: opts.title ?? '',
    icon: 'loading',
    duration: Infinity,
    mask: opts.mask ?? false,
  })
  onSuccess?.({ errMsg: 'showLoading:ok' })
  onComplete?.()
}

export function hideLoading(this: MiniAppContext, opts: { success?: unknown; complete?: unknown } = {}) {
  const { onSuccess, onComplete } = bindCallbacks(this, opts)
  uiOverlayBus.hideToast()
  onSuccess?.({ errMsg: 'hideLoading:ok' })
  onComplete?.()
}

interface ModalOpts {
  title?: string
  content?: string
  showCancel?: boolean
  cancelText?: string
  cancelColor?: string
  confirmText?: string
  confirmColor?: string
  editable?: boolean
  placeholderText?: string
  success?: unknown
  fail?: unknown
  complete?: unknown
}

export function showModal(this: MiniAppContext, opts: ModalOpts = {}) {
  const { onSuccess, onComplete } = bindCallbacks(this, opts)
  const editable = opts.editable ?? false
  // Guard against a double resolution (rapid double-tap / a re-render firing the
  // handler twice) settling the callbacks more than once.
  let settled = false
  uiOverlayBus.showDialog({
    kind: 'modal',
    title: opts.title ?? '',
    content: opts.content ?? '',
    showCancel: opts.showCancel ?? true,
    cancelText: opts.cancelText ?? '取消',
    cancelColor: opts.cancelColor ?? '#000000',
    confirmText: opts.confirmText ?? '确定',
    confirmColor: opts.confirmColor ?? '#576B95',
    editable,
    placeholderText: opts.placeholderText ?? '',
    onResult: (confirmed, content) => {
      if (settled) return
      settled = true
      uiOverlayBus.hideDialog()
      const result: Record<string, unknown> = {
        confirm: confirmed,
        cancel: !confirmed,
        errMsg: 'showModal:ok',
      }
      if (editable) result.content = content ?? ''
      onSuccess?.(result)
      onComplete?.()
    },
  })
}

interface ActionSheetOpts {
  itemList?: string[]
  itemColor?: string
  success?: unknown
  fail?: unknown
  complete?: unknown
}

export function showActionSheet(this: MiniAppContext, opts: ActionSheetOpts = {}) {
  const { onSuccess, onFail, onComplete } = bindCallbacks(this, opts)
  let settled = false
  uiOverlayBus.showDialog({
    kind: 'actionSheet',
    itemList: opts.itemList ?? [],
    itemColor: opts.itemColor ?? '#000000',
    onSelect: (index) => {
      if (settled) return
      settled = true
      uiOverlayBus.hideDialog()
      if (index === -1) {
        onFail?.({ errMsg: 'showActionSheet:fail cancel' })
      } else {
        onSuccess?.({ tapIndex: index, errMsg: 'showActionSheet:ok' })
      }
      onComplete?.()
    },
  })
}

interface ShareOpts {
  type?: string
  title?: string
  desc?: string
  url?: string
  cover?: string
  image?: string
  success?: unknown
  fail?: unknown
  complete?: unknown
}

export function share(this: MiniAppContext, opts: ShareOpts = {}) {
  const { onSuccess, onFail, onComplete } = bindCallbacks(this, opts)
  let settled = false
  const shareType = (opts.type === 'image' ? 'image' : 'link') as 'link' | 'image'
  uiOverlayBus.showDialog({
    kind: 'share',
    type: shareType,
    title: opts.title ?? '',
    desc: opts.desc ?? '',
    url: opts.url ?? '',
    cover: opts.cover ?? '',
    image: opts.image ?? '',
    onSelect: (index) => {
      if (settled) return
      settled = true
      uiOverlayBus.hideDialog()
      if (index === -1) {
        onFail?.({ errMsg: 'share:fail cancel' })
      } else {
        onSuccess?.({ errMsg: 'share:ok' })
      }
      onComplete?.()
    },
  })
}

interface OpenPostOpts {
  islandId?: string
  appId?: string
  islandName?: string
  islandImage?: string
  joined?: boolean
  bizData?: string
  spuId?: string
  files?: string
  success?: unknown
  fail?: unknown
  complete?: unknown
}

export function openPost(this: MiniAppContext, opts: OpenPostOpts = {}) {
  const { onSuccess, onFail, onComplete } = bindCallbacks(this, opts)
  let settled = false
  uiOverlayBus.showDialog({
    kind: 'openPost',
    islandName: opts.islandName ?? '',
    islandImage: opts.islandImage ?? '',
    onResult: (confirmed) => {
      if (settled) return
      settled = true
      uiOverlayBus.hideDialog()
      if (confirmed) {
        onSuccess?.({ islandId: opts.islandId ?? '', errMsg: 'openPost:ok' })
      } else {
        onFail?.({ errMsg: 'openPost:fail cancel' })
      }
      onComplete?.()
    },
  })
}

interface JoinIslandOpts {
  islandName?: string
  islandAvatar?: string
  memberCount?: string
  success?: unknown
  fail?: unknown
  complete?: unknown
}

export function joinIsland(this: MiniAppContext, opts: JoinIslandOpts = {}) {
  const { onSuccess, onFail, onComplete } = bindCallbacks(this, opts)
  let settled = false
  uiOverlayBus.showDialog({
    kind: 'halfSheet',
    islandName: opts.islandName ?? 'Mock Island',
    islandAvatar: opts.islandAvatar ?? '',
    memberCount: opts.memberCount ?? '128',
    onResult: (confirmed) => {
      if (settled) return
      settled = true
      uiOverlayBus.hideDialog()
      if (confirmed) {
        onSuccess?.({ errMsg: 'joinIsland:ok' })
      } else {
        onFail?.({ errMsg: 'joinIsland:fail cancel' })
      }
      onComplete?.()
    },
  })
}
