import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type CapsuleMenuDialogState, uiOverlayBus } from './ui-overlay-bus'

beforeEach(() => {
  uiOverlayBus.hideDialog()
})

function pushMenu(onSelect?: (index: number) => void): CapsuleMenuDialogState {
  const dialog: CapsuleMenuDialogState = {
    kind: 'capsuleMenu',
    appName: 'Test App',
    appAvatar: '',
    appVersion: '1.0.0',
    items: [{ label: '复制链接', icon: '🔗' }],
    onSelect: onSelect ?? vi.fn(),
  }
  uiOverlayBus.showDialog(dialog)
  return dialog
}

describe('capsule menu dialog via uiOverlayBus', () => {
  it('pushes a dialog with kind=capsuleMenu', () => {
    pushMenu()
    expect(uiOverlayBus.getState().dialog?.kind).toBe('capsuleMenu')
  })

  it('stores app metadata on the dialog', () => {
    pushMenu()
    const d = uiOverlayBus.getState().dialog as CapsuleMenuDialogState
    expect(d.appName).toBe('Test App')
    expect(d.appAvatar).toBe('')
    expect(d.appVersion).toBe('1.0.0')
  })

  it('stores items on the dialog', () => {
    pushMenu()
    const d = uiOverlayBus.getState().dialog as CapsuleMenuDialogState
    expect(d.items).toEqual([{ label: '复制链接', icon: '🔗' }])
  })

  it('does NOT fire onSelect before user interaction', () => {
    const onSelect = vi.fn()
    pushMenu(onSelect)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('onSelect(-1) fires the callback with -1 (cancel)', () => {
    const onSelect = vi.fn()
    pushMenu(onSelect)
    const d = uiOverlayBus.getState().dialog as CapsuleMenuDialogState
    d.onSelect(-1)
    expect(onSelect).toHaveBeenCalledWith(-1)
  })

  it('onSelect(0) fires the callback with the item index', () => {
    const onSelect = vi.fn()
    pushMenu(onSelect)
    const d = uiOverlayBus.getState().dialog as CapsuleMenuDialogState
    d.onSelect(0)
    expect(onSelect).toHaveBeenCalledWith(0)
  })

  it('dialog clears when onSelect calls hideDialog', () => {
    const dialog = pushMenu((index) => {
      if (index === -1) uiOverlayBus.hideDialog()
    })
    dialog.onSelect(-1)
    expect(uiOverlayBus.getState().dialog).toBeNull()
  })

  it('dialog clears when item select calls hideDialog', () => {
    const dialog = pushMenu(() => {
      uiOverlayBus.hideDialog()
    })
    dialog.onSelect(0)
    expect(uiOverlayBus.getState().dialog).toBeNull()
  })
})

describe('capsule menu — double-settle guard', () => {
  it('second onSelect after hideDialog does not resurrect the dialog', () => {
    let callCount = 0
    const dialog = pushMenu(() => {
      callCount++
      uiOverlayBus.hideDialog()
    })
    dialog.onSelect(0)
    expect(callCount).toBe(1)
    expect(uiOverlayBus.getState().dialog).toBeNull()
    dialog.onSelect(0)
    expect(callCount).toBe(2)
    expect(uiOverlayBus.getState().dialog).toBeNull()
  })

  it('subscribers are notified when dialog is shown and cleared', () => {
    const listener = vi.fn()
    uiOverlayBus.subscribe(listener)
    const dialog = pushMenu(() => {
      uiOverlayBus.hideDialog()
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].dialog).toBe(dialog)
    dialog.onSelect(-1)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener.mock.calls[1][0].dialog).toBeNull()
  })
})
