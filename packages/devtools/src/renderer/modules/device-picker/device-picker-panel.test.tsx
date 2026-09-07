/**
 * The device-picker overlay WebContentsView is reused across openings, so the
 * shell must drop its device back to null on select/dismiss: that unmounts
 * `DevicePicker`, and the NEXT `devicePicker:show` mounts a fresh one instead
 * of one still carrying the previous session's search text and chip filters.
 * The shell also owns the two outbound channels — a pick goes out as
 * `selectDevice`, a dismissal as `cancelDevicePicker`.
 */
import { render, screen, fireEvent, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEVICE_NAMES } from '@devicekit/devices'

const {
  onDevicePickerInitMock,
  notifyOverlayReadyMock,
  selectDeviceMock,
  cancelDevicePickerMock,
  initHandlers,
} = vi.hoisted(() => {
  const initHandlers: Array<(payload: { deviceName: string }) => void> = []
  return {
    onDevicePickerInitMock: vi.fn((handler: (payload: { deviceName: string }) => void) => {
      initHandlers.push(handler)
      return () => {
        const idx = initHandlers.indexOf(handler)
        if (idx >= 0) initHandlers.splice(idx, 1)
      }
    }),
    notifyOverlayReadyMock: vi.fn(),
    selectDeviceMock: vi.fn(),
    cancelDevicePickerMock: vi.fn(),
    initHandlers,
  }
})

vi.mock('@/shared/api', () => ({
  notifyOverlayReady: notifyOverlayReadyMock,
  onDevicePickerInit: onDevicePickerInitMock,
  selectDevice: selectDeviceMock,
  cancelDevicePicker: cancelDevicePickerMock,
}))

// cmdk measures its list via ResizeObserver, which jsdom does not implement.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

import DevicePickerPanel from './device-picker-panel'

const SEARCH_PLACEHOLDER = '搜索机型：名称 / 系统 / 尺寸'

beforeEach(() => {
  initHandlers.length = 0
  notifyOverlayReadyMock.mockClear()
  selectDeviceMock.mockClear()
  cancelDevicePickerMock.mockClear()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

function fireInit(deviceName: string) {
  act(() => { for (const h of [...initHandlers]) h({ deviceName }) })
}

describe('DevicePickerPanel: nothing renders before main pushes a device', () => {
  it('announces readiness and stays empty until the first init', () => {
    render(<DevicePickerPanel />)

    expect(notifyOverlayReadyMock).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('DevicePickerPanel: relaying the outcome to main', () => {
  it('sends the picked device name', async () => {
    render(<DevicePickerPanel />)
    fireInit(DEVICE_NAMES.iPhone_14_Pro)

    fireEvent.click(await screen.findByRole('option', { name: DEVICE_NAMES.Galaxy_Tab_S9 }))

    expect(selectDeviceMock).toHaveBeenCalledWith({ deviceName: DEVICE_NAMES.Galaxy_Tab_S9 })
    expect(cancelDevicePickerMock).not.toHaveBeenCalled()
  })

  it('sends a cancel when the panel is dismissed with Escape', async () => {
    render(<DevicePickerPanel />)
    fireInit(DEVICE_NAMES.iPhone_14_Pro)

    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' })

    expect(cancelDevicePickerMock).toHaveBeenCalledTimes(1)
    expect(selectDeviceMock).not.toHaveBeenCalled()
  })
})

describe('DevicePickerPanel: reopening starts from a clean panel', () => {
  it('drops the previous session\'s search text before the next show renders', async () => {
    render(<DevicePickerPanel />)
    fireInit(DEVICE_NAMES.iPhone_14_Pro)

    fireEvent.change(await screen.findByPlaceholderText(SEARCH_PLACEHOLDER), {
      target: { value: 'tab s9' },
    })
    expect(screen.getByPlaceholderText(SEARCH_PLACEHOLDER)).toHaveValue('tab s9')

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    fireInit(DEVICE_NAMES.iPhone_14_Pro)

    expect(await screen.findByPlaceholderText(SEARCH_PLACEHOLDER)).toHaveValue('')
  })

  it('drops the previous session\'s os chip filter before the next show renders', async () => {
    render(<DevicePickerPanel />)
    fireInit(DEVICE_NAMES.iPhone_14_Pro)

    fireEvent.click(await screen.findByRole('button', { name: 'iOS' }))
    expect(screen.queryByRole('option', { name: DEVICE_NAMES.Galaxy_Tab_S9 })).toBeNull()

    fireEvent.click(screen.getByRole('option', { name: DEVICE_NAMES.iPhone_15 }))
    fireInit(DEVICE_NAMES.iPhone_15)

    expect(await screen.findByRole('option', { name: DEVICE_NAMES.Galaxy_Tab_S9 })).toBeInTheDocument()
  })
})
