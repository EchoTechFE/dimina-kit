import { useEffect, useRef, useState } from 'react'
import {
  uiOverlayBus,
  type ActionSheetDialogState,
  type CapsuleMenuDialogState,
  type HalfSheetDialogState,
  type ModalDialogState,
  type ShareDialogState,
  type ToastState,
  type UiOverlayState,
} from '../ui-overlay-bus'
import shareWechatIcon from './icons/share_wechat.svg'
import sharePyqIcon from './icons/share_pyq.svg'
import copylinkIcon from './icons/copylink.svg'
import downloadIcon from './icons/download_app.svg'
import { OpenPostView } from './open-post-view'
import './ui-overlay.css'

/**
 * Renders the native interaction overlays (toast / loading / modal /
 * action sheet) inside the device frame. Subscribes to `uiOverlayBus`, which
 * the simulator-resident wx.* handlers in `simulator-api-ui.ts` push into.
 *
 * Mounted as the last child of `.device-shell` so it layers above the page
 * <webview> (same approach as the status/nav bar) and is clipped to the bezel.
 */
export function UiOverlay() {
  const [{ toast, dialog }, setState] = useState<UiOverlayState>(() => uiOverlayBus.getState())
  useEffect(() => uiOverlayBus.subscribe(setState), [])

  return (
    <>
      {toast && <ToastView toast={toast} />}
      {dialog?.kind === 'modal' && <ModalView dialog={dialog} />}
      {dialog?.kind === 'actionSheet' && <ActionSheetView dialog={dialog} />}
      {dialog?.kind === 'halfSheet' && <HalfSheetView dialog={dialog} />}
      {dialog?.kind === 'capsuleMenu' && <CapsuleMenuView dialog={dialog} />}
      {dialog?.kind === 'share' && <ShareView dialog={dialog} />}
      {dialog?.kind === 'openPost' && <OpenPostView dialog={dialog} />}
    </>
  )
}

// ─── Toast / Loading ──────────────────────────────────────────────────────────

function ToastView({ toast }: { toast: ToastState }) {
  // Auto-dismiss after `duration` (showLoading uses Infinity → no timer; it is
  // cleared explicitly by hideLoading/hideToast). Re-armed whenever the toast
  // identity changes (a second showToast resets the countdown).
  useEffect(() => {
    if (!Number.isFinite(toast.duration)) return
    const id = window.setTimeout(() => uiOverlayBus.dismissToast(toast), toast.duration)
    return () => window.clearTimeout(id)
  }, [toast])

  const hasIndicator = toast.icon !== 'none' || !!toast.image
  return (
    <div className="dmui-overlay" aria-live="polite">
      {toast.mask && <div className="dmui-mask dmui-mask--transparent" />}
      <div className={`dmui-toast${hasIndicator ? '' : ' dmui-toast--text'}`} role="alert">
        {toast.image ? (
          <img className="dmui-toast__image" src={toast.image} alt="" />
        ) : (
          <ToastIcon icon={toast.icon} />
        )}
        {toast.title && <div className="dmui-toast__title">{toast.title}</div>}
      </div>
    </div>
  )
}

function ToastIcon({ icon }: { icon: ToastState['icon'] }) {
  if (icon === 'success') {
    return (
      <svg className="dmui-toast__icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 13l4 4L19 7" />
      </svg>
    )
  }
  if (icon === 'error') {
    return (
      <svg className="dmui-toast__icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    )
  }
  if (icon === 'loading') {
    return <span className="dmui-toast__spinner" aria-hidden="true" />
  }
  return null
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function ModalView({ dialog }: { dialog: ModalDialogState }) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (dialog.editable) inputRef.current?.focus()
  }, [dialog.editable])

  return (
    <div className="dmui-overlay">
      <div className="dmui-mask" />
      <div className="dmui-modal" role="dialog" aria-modal="true">
        {dialog.title && <div className="dmui-modal__title">{dialog.title}</div>}
        {dialog.editable ? (
          <input
            ref={inputRef}
            className="dmui-modal__input"
            value={value}
            placeholder={dialog.placeholderText}
            onChange={(e) => setValue(e.target.value)}
          />
        ) : (
          dialog.content && <div className="dmui-modal__content">{dialog.content}</div>
        )}
        <div className="dmui-modal__actions">
          {dialog.showCancel && (
            <button
              type="button"
              className="dmui-modal__button"
              style={{ color: dialog.cancelColor }}
              onClick={() => dialog.onResult(false)}
            >
              {dialog.cancelText}
            </button>
          )}
          <button
            type="button"
            className="dmui-modal__button"
            style={{ color: dialog.confirmColor }}
            onClick={() => dialog.onResult(true, value)}
          >
            {dialog.confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Action sheet ─────────────────────────────────────────────────────────────

function ActionSheetView({ dialog }: { dialog: ActionSheetDialogState }) {
  return (
    <div className="dmui-overlay">
      <div className="dmui-mask" onClick={() => dialog.onSelect(-1)} />
      <div className="dmui-action-sheet" role="menu">
        <div className="dmui-action-sheet__items">
          {dialog.itemList.map((item, index) => (
            <button
              type="button"
              key={index}
              className="dmui-action-sheet__item"
              style={{ color: dialog.itemColor }}
              onClick={() => dialog.onSelect(index)}
            >
              {item}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="dmui-action-sheet__cancel"
          onClick={() => dialog.onSelect(-1)}
        >
          取消
        </button>
      </div>
    </div>
  )
}

// ─── Half sheet (joinIsland) ─────────────────────────────────────────────────

function HalfSheetView({ dialog }: { dialog: HalfSheetDialogState }) {
  return (
    <div className="dmui-overlay">
      <div className="dmui-mask" onClick={() => dialog.onResult(false)} />
      <div className="dmui-half-sheet" role="dialog" aria-modal="true">
        <div className="dmui-half-sheet__title">加入岛即可发布讨论</div>
        <div className="dmui-half-sheet__divider" />
        <div className="dmui-half-sheet__row">
          {dialog.islandAvatar && (
            <img className="dmui-half-sheet__avatar" src={dialog.islandAvatar} alt="" />
          )}
          <div className="dmui-half-sheet__info">
            <div className="dmui-half-sheet__name">{dialog.islandName}</div>
            <div className="dmui-half-sheet__members">{dialog.memberCount}人加入</div>
          </div>
          <button
            type="button"
            className="dmui-half-sheet__join"
            onClick={() => dialog.onResult(true)}
          >
            加入
          </button>
        </div>
        <div className="dmui-half-sheet__divider" />
        <button
          type="button"
          className="dmui-half-sheet__cancel"
          onClick={() => dialog.onResult(false)}
        >
          取消
        </button>
      </div>
    </div>
  )
}

// ─── Capsule menu (more button popup) ────────────────────────────────────────

function CapsuleMenuView({ dialog }: { dialog: CapsuleMenuDialogState }) {
  return (
    <div className="dmui-overlay">
      <div className="dmui-mask" onClick={() => dialog.onSelect(-1)} />
      <div className="dmui-bottom-sheet" role="dialog" aria-modal="true">
        <div className="dmui-capsule-menu__header">
          {dialog.appAvatar ? (
            <img className="dmui-capsule-menu__avatar" src={dialog.appAvatar} alt="" />
          ) : (
            <div className="dmui-capsule-menu__avatar dmui-capsule-menu__avatar--placeholder" />
          )}
          <div className="dmui-capsule-menu__app-info">
            <div className="dmui-capsule-menu__app-name">{dialog.appName}</div>
            <div className="dmui-capsule-menu__app-version">V{dialog.appVersion}</div>
          </div>
        </div>
        <div className="dmui-bottom-sheet__divider" />
        <div className="dmui-bottom-sheet__grid">
          {dialog.items.map((item, index) => (
            <button
              type="button"
              key={index}
              className="dmui-bottom-sheet__grid-item"
              onClick={() => dialog.onSelect(index)}
            >
              <div className="dmui-bottom-sheet__icon-circle">{item.icon}</div>
              <div className="dmui-bottom-sheet__item-label">{item.label}</div>
            </button>
          ))}
        </div>
        <div className="dmui-bottom-sheet__divider" />
        <button type="button" className="dmui-bottom-sheet__cancel" onClick={() => dialog.onSelect(-1)}>
          取消
        </button>
      </div>
    </div>
  )
}

// ─── Share sheet ──────────────────────────────────────────────────────────────

const SHARE_TARGETS = [
  { label: '微信', icon: shareWechatIcon },
  { label: '朋友圈', icon: sharePyqIcon },
]

function ShareView({ dialog }: { dialog: ShareDialogState }) {
  const extraAction = dialog.type === 'image'
    ? { label: '保存图片', icon: downloadIcon }
    : { label: '复制链接', icon: copylinkIcon }

  return (
    <div className="dmui-overlay">
      <div className="dmui-mask" onClick={() => dialog.onSelect(-1)} />
      <div className="dmui-bottom-sheet" role="dialog" aria-modal="true">
        <div className="dmui-bottom-sheet__title">分享到</div>
        <div className="dmui-bottom-sheet__divider" />
        <div className="dmui-bottom-sheet__grid">
          {SHARE_TARGETS.map((target, index) => (
            <button
              type="button"
              key={index}
              className="dmui-bottom-sheet__grid-item"
              onClick={() => dialog.onSelect(index)}
            >
              <div className="dmui-bottom-sheet__icon-circle">
                <img className="dmui-bottom-sheet__icon-img" src={target.icon} alt={target.label} />
              </div>
              <div className="dmui-bottom-sheet__item-label">{target.label}</div>
            </button>
          ))}
          <button
            type="button"
            className="dmui-bottom-sheet__grid-item"
            onClick={() => dialog.onSelect(SHARE_TARGETS.length)}
          >
            <div className="dmui-bottom-sheet__icon-circle">
              <img className="dmui-bottom-sheet__icon-img" src={extraAction.icon} alt={extraAction.label} />
            </div>
            <div className="dmui-bottom-sheet__item-label">{extraAction.label}</div>
          </button>
        </div>
        <div className="dmui-bottom-sheet__divider" />
        <button type="button" className="dmui-bottom-sheet__cancel" onClick={() => dialog.onSelect(-1)}>
          取消
        </button>
      </div>
    </div>
  )
}

