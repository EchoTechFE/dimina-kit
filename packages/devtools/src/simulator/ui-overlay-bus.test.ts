import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ActionSheetDialogState,
  type ModalDialogState,
  type ToastState,
  uiOverlayBus,
} from './ui-overlay-bus'

// Reset singleton between tests.
beforeEach(() => {
  uiOverlayBus.hideToast()
  uiOverlayBus.hideDialog()
})

// ─── initial state ────────────────────────────────────────────────────────────

describe('initial state', () => {
  it('getState returns { toast: null, dialog: null }', () => {
    expect(uiOverlayBus.getState()).toEqual({ toast: null, dialog: null })
  })
})

// ─── showToast / hideToast ────────────────────────────────────────────────────

describe('showToast', () => {
  const toast: ToastState = {
    title: 'Done',
    icon: 'success',
    duration: 1500,
    mask: false,
  }

  it('sets state.toast to the provided value', () => {
    uiOverlayBus.showToast(toast)
    expect(uiOverlayBus.getState().toast).toEqual(toast)
  })

  it('does not touch state.dialog', () => {
    const dialog: ModalDialogState = {
      kind: 'modal',
      title: 'T',
      content: 'C',
      showCancel: true,
      cancelText: '取消',
      cancelColor: '#000000',
      confirmText: '确定',
      confirmColor: '#576B95',
      editable: false,
      placeholderText: '',
      onResult: vi.fn(),
    }
    uiOverlayBus.showDialog(dialog)
    uiOverlayBus.showToast(toast)
    expect(uiOverlayBus.getState().dialog).toBe(dialog)
  })

  it('notifies subscribers synchronously with the new state', () => {
    const listener = vi.fn()
    uiOverlayBus.subscribe(listener)
    uiOverlayBus.showToast(toast)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(uiOverlayBus.getState())
  })

  it('notified state has toast equal to what was pushed', () => {
    const listener = vi.fn<(s: ReturnType<typeof uiOverlayBus.getState>) => void>()
    uiOverlayBus.subscribe(listener)
    uiOverlayBus.showToast(toast)
    expect(listener.mock.calls[0][0].toast).toEqual(toast)
  })
})

describe('hideToast', () => {
  it('sets state.toast back to null', () => {
    uiOverlayBus.showToast({ title: 'x', icon: 'none', duration: 1500, mask: false })
    uiOverlayBus.hideToast()
    expect(uiOverlayBus.getState().toast).toBeNull()
  })

  it('notifies subscribers when toast is cleared', () => {
    uiOverlayBus.showToast({ title: 'x', icon: 'none', duration: 1500, mask: false })
    const listener = vi.fn()
    uiOverlayBus.subscribe(listener)
    uiOverlayBus.hideToast()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].toast).toBeNull()
  })

  it('does not touch state.dialog', () => {
    const dialog: ActionSheetDialogState = {
      kind: 'actionSheet',
      itemList: ['A'],
      itemColor: '#000000',
      onSelect: vi.fn(),
    }
    uiOverlayBus.showDialog(dialog)
    uiOverlayBus.hideToast()
    expect(uiOverlayBus.getState().dialog).toBe(dialog)
  })
})

// ─── showDialog / hideDialog ──────────────────────────────────────────────────

describe('showDialog', () => {
  const modal: ModalDialogState = {
    kind: 'modal',
    title: 'Alert',
    content: 'Are you sure?',
    showCancel: true,
    cancelText: '取消',
    cancelColor: '#000000',
    confirmText: '确定',
    confirmColor: '#576B95',
    editable: false,
    placeholderText: '',
    onResult: vi.fn(),
  }

  it('sets state.dialog to the provided value', () => {
    uiOverlayBus.showDialog(modal)
    expect(uiOverlayBus.getState().dialog).toBe(modal)
  })

  it('notifies subscribers synchronously', () => {
    const listener = vi.fn()
    uiOverlayBus.subscribe(listener)
    uiOverlayBus.showDialog(modal)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].dialog).toBe(modal)
  })

  it('does not touch state.toast', () => {
    const toast: ToastState = { title: 'Hi', icon: 'success', duration: 1500, mask: false }
    uiOverlayBus.showToast(toast)
    uiOverlayBus.showDialog(modal)
    expect(uiOverlayBus.getState().toast).toEqual(toast)
  })
})

describe('hideDialog', () => {
  it('sets state.dialog back to null', () => {
    uiOverlayBus.showDialog({
      kind: 'actionSheet',
      itemList: [],
      itemColor: '#000000',
      onSelect: vi.fn(),
    })
    uiOverlayBus.hideDialog()
    expect(uiOverlayBus.getState().dialog).toBeNull()
  })

  it('notifies subscribers when dialog is cleared', () => {
    uiOverlayBus.showDialog({
      kind: 'actionSheet',
      itemList: [],
      itemColor: '#000000',
      onSelect: vi.fn(),
    })
    const listener = vi.fn()
    uiOverlayBus.subscribe(listener)
    uiOverlayBus.hideDialog()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].dialog).toBeNull()
  })
})

// ─── subscribe / unsubscribe ──────────────────────────────────────────────────

describe('subscribe', () => {
  it('returns an unsubscribe function', () => {
    const unsub = uiOverlayBus.subscribe(vi.fn())
    expect(typeof unsub).toBe('function')
  })

  it('listener is not called after unsubscribe', () => {
    const listener = vi.fn()
    const unsub = uiOverlayBus.subscribe(listener)
    unsub()
    uiOverlayBus.showToast({ title: 'x', icon: 'none', duration: 1500, mask: false })
    expect(listener).not.toHaveBeenCalled()
  })

  it('multiple subscribers each receive the notification', () => {
    const a = vi.fn()
    const b = vi.fn()
    uiOverlayBus.subscribe(a)
    uiOverlayBus.subscribe(b)
    uiOverlayBus.showToast({ title: 'multi', icon: 'success', duration: 2000, mask: true })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('unsubscribing one listener does not affect others', () => {
    const a = vi.fn()
    const b = vi.fn()
    const unsubA = uiOverlayBus.subscribe(a)
    uiOverlayBus.subscribe(b)
    unsubA()
    uiOverlayBus.hideToast()
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('getState() after notification reflects the same change', () => {
    let stateInCallback: ReturnType<typeof uiOverlayBus.getState> | null = null
    uiOverlayBus.subscribe((s) => {
      stateInCallback = s
    })
    uiOverlayBus.showToast({ title: 'sync', icon: 'loading', duration: 0, mask: false })
    expect(stateInCallback).toBe(uiOverlayBus.getState())
  })
})

// ─── dismissToast ─────────────────────────────────────────────────────────────
// Guards the race fix: the auto-dismiss timer holds a reference to the toast
// it scheduled. A blind hideToast() from a stale timer would clear a NEWER
// toast that replaced the old one — dismissToast(toast) only clears when
// `toast` is still the active one.

describe('dismissToast', () => {
  const t1: ToastState = { title: 'first', icon: 'success', duration: 1500, mask: false }
  const t2: ToastState = { title: 'second', icon: 'none', duration: 2000, mask: false }

  it('clears toast when the argument is the current active toast', () => {
    uiOverlayBus.showToast(t1)
    uiOverlayBus.dismissToast(t1)
    expect(uiOverlayBus.getState().toast).toBeNull()
  })

  it('is a no-op when the argument is a stale (superseded) toast — the newer toast stays', () => {
    uiOverlayBus.showToast(t1)
    uiOverlayBus.showToast(t2)
    // t1's auto-dismiss timer fires here — must NOT clear t2
    uiOverlayBus.dismissToast(t1)
    expect(uiOverlayBus.getState().toast).toBe(t2)
  })

  it('notifies subscribers when it clears the active toast', () => {
    uiOverlayBus.showToast(t1)
    const listener = vi.fn()
    uiOverlayBus.subscribe(listener)
    uiOverlayBus.dismissToast(t1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].toast).toBeNull()
  })

  it('does NOT notify subscribers when called with a stale toast', () => {
    uiOverlayBus.showToast(t1)
    uiOverlayBus.showToast(t2)
    const listener = vi.fn()
    uiOverlayBus.subscribe(listener)
    uiOverlayBus.dismissToast(t1)
    // No state change happened, so no notification
    expect(listener).not.toHaveBeenCalled()
  })
})
