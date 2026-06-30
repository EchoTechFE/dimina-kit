import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MiniAppContext } from './types'
import { type ActionSheetDialogState, type ModalDialogState, uiOverlayBus } from './ui-overlay-bus'
import {
  hideLoading,
  hideToast,
  showActionSheet,
  showLoading,
  showModal,
  showToast,
} from './simulator-api-ui'

// Passthrough context: createCallbackFunction returns the fn as-is.
function makeCtx(): MiniAppContext {
  return {
    appId: 'test-app',
    createCallbackFunction: (fn: unknown) => fn,
  } as unknown as MiniAppContext
}

beforeEach(() => {
  uiOverlayBus.hideToast()
  uiOverlayBus.hideDialog()
})

// ─── showToast ────────────────────────────────────────────────────────────────

describe('showToast', () => {
  it('pushes toast with provided fields', () => {
    const ctx = makeCtx()
    showToast.call(ctx, { title: 'Saved', icon: 'success', duration: 2000, mask: true })
    expect(uiOverlayBus.getState().toast).toEqual({
      title: 'Saved',
      icon: 'success',
      image: undefined,
      duration: 2000,
      mask: true,
    })
  })

  it('applies default icon=success, duration=1500, mask=false', () => {
    const ctx = makeCtx()
    showToast.call(ctx, { title: 'Hi' })
    const toast = uiOverlayBus.getState().toast!
    expect(toast.icon).toBe('success')
    expect(toast.duration).toBe(1500)
    expect(toast.mask).toBe(false)
  })

  it('propagates image when provided', () => {
    const ctx = makeCtx()
    showToast.call(ctx, { title: 'Hi', image: '/assets/ok.png' })
    expect(uiOverlayBus.getState().toast?.image).toBe('/assets/ok.png')
  })

  it('fires success with { errMsg: "showToast:ok" } synchronously', () => {
    const ctx = makeCtx()
    const success = vi.fn()
    showToast.call(ctx, { title: 'Hi', success })
    expect(success).toHaveBeenCalledTimes(1)
    expect(success).toHaveBeenCalledWith({ errMsg: 'showToast:ok' })
  })

  it('fires complete synchronously', () => {
    const ctx = makeCtx()
    const complete = vi.fn()
    showToast.call(ctx, { title: 'Hi', complete })
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('does not throw when success/complete are omitted', () => {
    const ctx = makeCtx()
    expect(() => showToast.call(ctx, { title: 'Hi' })).not.toThrow()
  })
})

// ─── hideToast ────────────────────────────────────────────────────────────────

describe('hideToast', () => {
  it('clears state.toast to null', () => {
    const ctx = makeCtx()
    showToast.call(ctx, { title: 'Loading…' })
    hideToast.call(ctx, {})
    expect(uiOverlayBus.getState().toast).toBeNull()
  })

  it('fires success with { errMsg: "hideToast:ok" }', () => {
    const ctx = makeCtx()
    const success = vi.fn()
    hideToast.call(ctx, { success })
    expect(success).toHaveBeenCalledWith({ errMsg: 'hideToast:ok' })
  })

  it('fires complete', () => {
    const ctx = makeCtx()
    const complete = vi.fn()
    hideToast.call(ctx, { complete })
    expect(complete).toHaveBeenCalledTimes(1)
  })
})

// ─── showLoading ──────────────────────────────────────────────────────────────

describe('showLoading', () => {
  it('pushes toast with icon=loading and duration=Infinity', () => {
    const ctx = makeCtx()
    showLoading.call(ctx, { title: 'Please wait…' })
    const toast = uiOverlayBus.getState().toast!
    expect(toast.title).toBe('Please wait…')
    expect(toast.icon).toBe('loading')
    expect(toast.duration).toBe(Infinity)
  })

  it('defaults mask to false', () => {
    const ctx = makeCtx()
    showLoading.call(ctx, { title: '...' })
    expect(uiOverlayBus.getState().toast?.mask).toBe(false)
  })

  it('propagates mask when provided', () => {
    const ctx = makeCtx()
    showLoading.call(ctx, { title: '...', mask: true })
    expect(uiOverlayBus.getState().toast?.mask).toBe(true)
  })

  it('image is undefined', () => {
    const ctx = makeCtx()
    showLoading.call(ctx, { title: '...' })
    expect(uiOverlayBus.getState().toast?.image).toBeUndefined()
  })

  it('fires success with { errMsg: "showLoading:ok" }', () => {
    const ctx = makeCtx()
    const success = vi.fn()
    showLoading.call(ctx, { title: '...', success })
    expect(success).toHaveBeenCalledWith({ errMsg: 'showLoading:ok' })
  })

  it('fires complete', () => {
    const ctx = makeCtx()
    const complete = vi.fn()
    showLoading.call(ctx, { title: '...', complete })
    expect(complete).toHaveBeenCalledTimes(1)
  })
})

// ─── hideLoading ──────────────────────────────────────────────────────────────

describe('hideLoading', () => {
  it('clears state.toast to null', () => {
    const ctx = makeCtx()
    showLoading.call(ctx, { title: '...' })
    hideLoading.call(ctx, {})
    expect(uiOverlayBus.getState().toast).toBeNull()
  })

  it('fires success with { errMsg: "hideLoading:ok" }', () => {
    const ctx = makeCtx()
    const success = vi.fn()
    hideLoading.call(ctx, { success })
    expect(success).toHaveBeenCalledWith({ errMsg: 'hideLoading:ok' })
  })

  it('fires complete', () => {
    const ctx = makeCtx()
    const complete = vi.fn()
    hideLoading.call(ctx, { complete })
    expect(complete).toHaveBeenCalledTimes(1)
  })
})

// ─── showModal ────────────────────────────────────────────────────────────────

describe('showModal', () => {
  it('pushes a modal dialog with kind=modal', () => {
    const ctx = makeCtx()
    showModal.call(ctx, { title: 'Confirm', content: 'Delete?' })
    const d = uiOverlayBus.getState().dialog
    expect(d?.kind).toBe('modal')
  })

  it('applies all default field values', () => {
    const ctx = makeCtx()
    showModal.call(ctx, {})
    const d = uiOverlayBus.getState().dialog as ModalDialogState
    expect(d.title).toBe('')
    expect(d.content).toBe('')
    expect(d.showCancel).toBe(true)
    expect(d.cancelText).toBe('取消')
    expect(d.cancelColor).toBe('#000000')
    expect(d.confirmText).toBe('确定')
    expect(d.confirmColor).toBe('#576B95')
    expect(d.editable).toBe(false)
    expect(d.placeholderText).toBe('')
  })

  it('respects provided fields over defaults', () => {
    const ctx = makeCtx()
    showModal.call(ctx, {
      title: 'My Title',
      confirmText: 'OK',
      showCancel: false,
    })
    const d = uiOverlayBus.getState().dialog as ModalDialogState
    expect(d.title).toBe('My Title')
    expect(d.confirmText).toBe('OK')
    expect(d.showCancel).toBe(false)
  })

  it('does NOT fire success or complete before user interaction', () => {
    const ctx = makeCtx()
    const success = vi.fn()
    const complete = vi.fn()
    showModal.call(ctx, { success, complete })
    expect(success).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
  })

  it('fires success with confirm=true when onResult(true) is called', () => {
    const ctx = makeCtx()
    const success = vi.fn()
    showModal.call(ctx, { success })
    const d = uiOverlayBus.getState().dialog as ModalDialogState
    d.onResult(true)
    expect(success).toHaveBeenCalledWith({ confirm: true, cancel: false, errMsg: 'showModal:ok' })
  })

  it('fires complete when onResult(true) is called', () => {
    const ctx = makeCtx()
    const complete = vi.fn()
    showModal.call(ctx, { complete })
    const d = uiOverlayBus.getState().dialog as ModalDialogState
    d.onResult(true)
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('clears dialog to null after onResult', () => {
    const ctx = makeCtx()
    showModal.call(ctx, {})
    const d = uiOverlayBus.getState().dialog as ModalDialogState
    d.onResult(true)
    expect(uiOverlayBus.getState().dialog).toBeNull()
  })

  it('fires success with confirm=false, cancel=true when onResult(false) is called', () => {
    const ctx = makeCtx()
    const success = vi.fn()
    showModal.call(ctx, { success })
    const d = uiOverlayBus.getState().dialog as ModalDialogState
    d.onResult(false)
    expect(success).toHaveBeenCalledWith({ confirm: false, cancel: true, errMsg: 'showModal:ok' })
  })

  it('includes typed content in success payload when editable=true and onResult(true, text)', () => {
    const ctx = makeCtx()
    const success = vi.fn()
    showModal.call(ctx, { editable: true, success })
    const d = uiOverlayBus.getState().dialog as ModalDialogState
    d.onResult(true, 'typed text')
    expect(success).toHaveBeenCalledWith({
      confirm: true,
      cancel: false,
      content: 'typed text',
      errMsg: 'showModal:ok',
    })
  })
})

// ─── showActionSheet ──────────────────────────────────────────────────────────

describe('showActionSheet', () => {
  it('pushes a dialog with kind=actionSheet', () => {
    const ctx = makeCtx()
    showActionSheet.call(ctx, { itemList: ['A', 'B'] })
    expect(uiOverlayBus.getState().dialog?.kind).toBe('actionSheet')
  })

  it('defaults itemList to [] and itemColor to #000000', () => {
    const ctx = makeCtx()
    showActionSheet.call(ctx, {})
    const d = uiOverlayBus.getState().dialog as ActionSheetDialogState
    expect(d.itemList).toEqual([])
    expect(d.itemColor).toBe('#000000')
  })

  it('uses provided itemList and itemColor', () => {
    const ctx = makeCtx()
    showActionSheet.call(ctx, { itemList: ['X', 'Y'], itemColor: '#FF0000' })
    const d = uiOverlayBus.getState().dialog as ActionSheetDialogState
    expect(d.itemList).toEqual(['X', 'Y'])
    expect(d.itemColor).toBe('#FF0000')
  })

  it('does NOT fire success/fail/complete before user selects', () => {
    const ctx = makeCtx()
    const success = vi.fn()
    const fail = vi.fn()
    const complete = vi.fn()
    showActionSheet.call(ctx, { itemList: ['A'], success, fail, complete })
    expect(success).not.toHaveBeenCalled()
    expect(fail).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
  })

  it('fires success with tapIndex when onSelect(index) is called', () => {
    const ctx = makeCtx()
    const success = vi.fn()
    showActionSheet.call(ctx, { itemList: ['A', 'B', 'C'], success })
    const d = uiOverlayBus.getState().dialog as ActionSheetDialogState
    d.onSelect(2)
    expect(success).toHaveBeenCalledWith({ tapIndex: 2, errMsg: 'showActionSheet:ok' })
  })

  it('fires complete when an item is selected', () => {
    const ctx = makeCtx()
    const complete = vi.fn()
    showActionSheet.call(ctx, { itemList: ['A'], complete })
    const d = uiOverlayBus.getState().dialog as ActionSheetDialogState
    d.onSelect(0)
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('clears dialog to null after selection', () => {
    const ctx = makeCtx()
    showActionSheet.call(ctx, { itemList: ['A'] })
    const d = uiOverlayBus.getState().dialog as ActionSheetDialogState
    d.onSelect(0)
    expect(uiOverlayBus.getState().dialog).toBeNull()
  })

  it('fires fail with "showActionSheet:fail cancel" when onSelect(-1)', () => {
    const ctx = makeCtx()
    const fail = vi.fn()
    showActionSheet.call(ctx, { itemList: ['A'], fail })
    const d = uiOverlayBus.getState().dialog as ActionSheetDialogState
    d.onSelect(-1)
    expect(fail).toHaveBeenCalledWith({ errMsg: 'showActionSheet:fail cancel' })
  })

  it('fires complete on cancel', () => {
    const ctx = makeCtx()
    const complete = vi.fn()
    showActionSheet.call(ctx, { itemList: ['A'], complete })
    const d = uiOverlayBus.getState().dialog as ActionSheetDialogState
    d.onSelect(-1)
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('does NOT fire success on cancel', () => {
    const ctx = makeCtx()
    const success = vi.fn()
    showActionSheet.call(ctx, { itemList: ['A'], success })
    const d = uiOverlayBus.getState().dialog as ActionSheetDialogState
    d.onSelect(-1)
    expect(success).not.toHaveBeenCalled()
  })

  it('clears dialog to null on cancel', () => {
    const ctx = makeCtx()
    showActionSheet.call(ctx, { itemList: ['A'] })
    const d = uiOverlayBus.getState().dialog as ActionSheetDialogState
    d.onSelect(-1)
    expect(uiOverlayBus.getState().dialog).toBeNull()
  })
})

// ─── double-settle guard ──────────────────────────────────────────────────────
// Guards the `settled` flag introduced to prevent rapid double-taps or React
// re-renders from settling the modal/actionSheet callbacks more than once.

describe('showModal — double-settle guard', () => {
  it('fires success exactly once even when onResult is called twice', () => {
    const ctx = makeCtx()
    const success = vi.fn()
    showModal.call(ctx, { success })
    const d = uiOverlayBus.getState().dialog as ModalDialogState
    d.onResult(true)
    d.onResult(true)
    expect(success).toHaveBeenCalledTimes(1)
  })

  it('fires complete exactly once even when onResult is called twice', () => {
    const ctx = makeCtx()
    const complete = vi.fn()
    showModal.call(ctx, { complete })
    const d = uiOverlayBus.getState().dialog as ModalDialogState
    d.onResult(true)
    d.onResult(true)
    expect(complete).toHaveBeenCalledTimes(1)
  })
})

describe('showActionSheet — double-settle guard', () => {
  it('fires success exactly once (with first tapIndex) when onSelect is called twice', () => {
    const ctx = makeCtx()
    const success = vi.fn()
    showActionSheet.call(ctx, { itemList: ['A', 'B', 'C'], success })
    const d = uiOverlayBus.getState().dialog as ActionSheetDialogState
    d.onSelect(1)
    d.onSelect(0) // second call must be ignored
    expect(success).toHaveBeenCalledTimes(1)
    expect(success).toHaveBeenCalledWith({ tapIndex: 1, errMsg: 'showActionSheet:ok' })
  })

  it('fires complete exactly once when onSelect is called twice', () => {
    const ctx = makeCtx()
    const complete = vi.fn()
    showActionSheet.call(ctx, { itemList: ['A', 'B', 'C'], complete })
    const d = uiOverlayBus.getState().dialog as ActionSheetDialogState
    d.onSelect(2)
    d.onSelect(-1) // cancel on the second call must be ignored
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('does not fire fail when a valid selection is followed by a cancel call', () => {
    const ctx = makeCtx()
    const fail = vi.fn()
    showActionSheet.call(ctx, { itemList: ['A', 'B', 'C'], fail })
    const d = uiOverlayBus.getState().dialog as ActionSheetDialogState
    d.onSelect(2)   // first: valid selection
    d.onSelect(-1)  // second: cancel attempt — must be swallowed by settled guard
    expect(fail).not.toHaveBeenCalled()
  })
})
