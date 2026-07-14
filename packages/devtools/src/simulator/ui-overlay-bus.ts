/**
 * In-renderer pub/sub store for the simulator's native UI overlays (toast,
 * loading, modal, action sheet).
 *
 * The wx.* UI handlers in `simulator-api-ui.ts` run inside the simulator
 * renderer (via runApiAsync) but cannot touch React state directly. They push
 * the desired overlay into this singleton; the `DeviceShell`-resident
 * `<UiOverlay>` subscribes and renders it inside the device frame (above the
 * page <webview>, clipped to the bezel — the same layering the status/nav bar
 * already use). User interaction (modal confirm/cancel, action-sheet tap) is
 * routed back to the handler through the `onResult` / `onSelect` callbacks the
 * handler attaches to the dialog state.
 */

export interface ToastState {
  title: string
  icon: 'success' | 'error' | 'loading' | 'none'
  image?: string
  /** ms before auto-dismiss; Infinity for showLoading (dismissed explicitly). */
  duration: number
  mask: boolean
}

export interface ModalDialogState {
  kind: 'modal'
  title: string
  content: string
  showCancel: boolean
  cancelText: string
  cancelColor: string
  confirmText: string
  confirmColor: string
  editable: boolean
  placeholderText: string
  /** The renderer calls this when the user taps confirm/cancel. */
  onResult: (confirmed: boolean, content?: string) => void
}

export interface ActionSheetDialogState {
  kind: 'actionSheet'
  itemList: string[]
  itemColor: string
  /** The renderer calls this with the tapped index, or -1 to cancel. */
  onSelect: (index: number) => void
}

export interface HalfSheetDialogState {
  kind: 'halfSheet'
  islandName: string
  islandAvatar: string
  memberCount: string
  /** The renderer calls this with `true` (join) or `false` (cancel / mask tap). */
  onResult: (confirmed: boolean) => void
}

export interface CapsuleMenuItem {
  label: string
  icon: string
}

export interface CapsuleMenuDialogState {
  kind: 'capsuleMenu'
  appName: string
  appAvatar: string
  appVersion: string
  items: CapsuleMenuItem[]
  /** The renderer calls this with the tapped item index, or -1 to cancel. */
  onSelect: (index: number) => void
}

export interface ShareDialogState {
  kind: 'share'
  type: 'link' | 'image'
  title: string
  desc: string
  url: string
  cover: string
  image: string
  /** The renderer calls this with the tapped platform index, or -1 to cancel. */
  onSelect: (index: number) => void
}

export interface OpenPostDialogState {
  kind: 'openPost'
  islandName: string
  islandImage: string
  /** The renderer calls this with `true` (confirm) or `false` (cancel). */
  onResult: (confirmed: boolean) => void
}

export type DialogState =
  | ModalDialogState
  | ActionSheetDialogState
  | HalfSheetDialogState
  | CapsuleMenuDialogState
  | ShareDialogState
  | OpenPostDialogState

export interface UiOverlayState {
  toast: ToastState | null
  dialog: DialogState | null
}

type Listener = (state: UiOverlayState) => void

class UiOverlayBus {
  private state: UiOverlayState = { toast: null, dialog: null }
  private readonly listeners = new Set<Listener>()

  getState(): UiOverlayState {
    return this.state
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  showToast(toast: ToastState): void {
    this.set({ ...this.state, toast })
  }

  hideToast(): void {
    this.set({ ...this.state, toast: null })
  }

  /**
   * Clear `toast` only if it is still the active one. The toast auto-dismiss
   * timer holds a reference to the toast it scheduled; a newer showToast may
   * have replaced it in the meantime, and a blind `hideToast()` from the stale
   * timer would wrongly clear the new toast.
   */
  dismissToast(toast: ToastState): void {
    if (this.state.toast === toast) this.hideToast()
  }

  showDialog(dialog: DialogState): void {
    this.set({ ...this.state, dialog })
  }

  hideDialog(): void {
    this.set({ ...this.state, dialog: null })
  }

  private set(next: UiOverlayState): void {
    this.state = next
    for (const listener of this.listeners) listener(next)
  }
}

export const uiOverlayBus = new UiOverlayBus()
