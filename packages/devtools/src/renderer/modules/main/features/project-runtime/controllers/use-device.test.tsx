/**
 * useDevice against the @devicekit/devices contract: device selection and
 * orientation both drive a single NativeDeviceInfo push (`setNativeDeviceInfo`),
 * and simPanelWidth tracks the framed (bezel-inclusive) size for the current
 * device/orientation pair rather than the bare screen width.
 *
 * handleDeviceChange takes the device name directly (DevicePicker's
 * `onSelect` is `(name: string) => void`, not a <select> ChangeEvent).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  DEFAULT_DEVICE,
  DEVICE_NAMES,
  findDevice,
  resolveDevice,
  safeAreaInsetsFor,
  statusBarHeightFor,
} from '@devicekit/devices'
import { frameOuterSize } from '@devicekit/frame'
import { computeSimPanelWidth } from '../lib/device-geometry'
import { useDevice } from './use-device'

const { devicePickerHandlers } = vi.hoisted(() => ({
  devicePickerHandlers: [] as Array<(payload: { deviceName: string }) => void>,
}))

vi.mock('@/shared/api', () => ({
  setNativeDeviceInfo: vi.fn(),
  showDevicePicker: vi.fn(),
  onDevicePickerSelected: vi.fn((handler: (payload: { deviceName: string }) => void) => {
    devicePickerHandlers.push(handler)
    return () => {
      const idx = devicePickerHandlers.indexOf(handler)
      if (idx >= 0) devicePickerHandlers.splice(idx, 1)
    }
  }),
}))

import { setNativeDeviceInfo, showDevicePicker } from '@/shared/api'

function lastPayload() {
  const calls = vi.mocked(setNativeDeviceInfo).mock.calls
  return calls[calls.length - 1]![0]
}

function firePicked(deviceName: string) {
  act(() => {
    for (const handler of [...devicePickerHandlers]) handler({ deviceName })
  })
}

beforeEach(() => {
  devicePickerHandlers.length = 0
  vi.mocked(setNativeDeviceInfo).mockClear()
  vi.mocked(showDevicePicker).mockClear()
})

describe('useDevice: initial state', () => {
  it('defaults to DEFAULT_DEVICE in portrait', () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEFAULT_DEVICE }))
    expect(result.current.device).toBe(DEFAULT_DEVICE)
    expect(result.current.orientation).toBe('portrait')
  })
})

describe('useDevice: selecting an Android device', () => {
  it('pushes a platform/orientation-tagged payload with no notchType and a non-Apple brand', () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEFAULT_DEVICE }))
    const pixel8 = resolveDevice(findDevice(DEVICE_NAMES.Pixel_8)!)

    act(() => {
      result.current.handleDeviceChange(DEVICE_NAMES.Pixel_8)
    })

    const payload = lastPayload()
    expect(payload).toMatchObject({
      device: DEVICE_NAMES.Pixel_8,
      platform: 'android',
      orientation: 'portrait',
      screenWidth: 412,
      screenHeight: pixel8.screen.height,
      pixelRatio: pixel8.pixelRatio,
      statusBarHeight: statusBarHeightFor(pixel8, 'portrait'),
      safeAreaInsets: safeAreaInsetsFor(pixel8, 'portrait'),
    })
    expect(payload).not.toHaveProperty('notchType')
    expect(payload.brand).not.toBe('Apple')
  })
})

describe('useDevice: rotating to landscape', () => {
  it('re-sends device info with swapped dimensions and the landscape insets/statusBarHeight', () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEFAULT_DEVICE }))
    const iphone15 = resolveDevice(findDevice(DEVICE_NAMES.iPhone_15)!)

    act(() => {
      result.current.handleDeviceChange(DEVICE_NAMES.iPhone_15)
    })
    vi.mocked(setNativeDeviceInfo).mockClear()

    act(() => {
      result.current.handleOrientationChange('landscape')
    })

    expect(result.current.orientation).toBe('landscape')
    const payload = lastPayload()
    expect(payload).toMatchObject({
      device: DEVICE_NAMES.iPhone_15,
      orientation: 'landscape',
      screenWidth: iphone15.screen.height,
      screenHeight: iphone15.screen.width,
      statusBarHeight: statusBarHeightFor(iphone15, 'landscape'),
      safeAreaInsets: safeAreaInsetsFor(iphone15, 'landscape'),
    })
  })
})

describe('useDevice: selecting an unknown device name', () => {
  it('falls back to DEFAULT_DEVICE', () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEFAULT_DEVICE }))

    act(() => {
      result.current.handleDeviceChange('Definitely Not A Real Phone')
    })

    expect(result.current.device).toBe(DEFAULT_DEVICE)
  })
})

describe('useDevice: simPanelWidth follows the framed (bezel-inclusive) size', () => {
  it('recomputes simPanelWidth from frameOuterSize on device change', () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEFAULT_DEVICE }))
    const pixel8Profile = findDevice(DEVICE_NAMES.Pixel_8)!

    act(() => {
      result.current.handleDeviceChange(DEVICE_NAMES.Pixel_8)
    })

    expect(result.current.simPanelWidth).toBe(computeSimPanelWidth(frameOuterSize(pixel8Profile, 'portrait').width))
  })

  it('recomputes simPanelWidth from frameOuterSize on orientation change', () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEFAULT_DEVICE }))
    const defaultProfile = DEFAULT_DEVICE

    act(() => {
      result.current.handleOrientationChange('landscape')
    })

    expect(result.current.simPanelWidth).toBe(computeSimPanelWidth(frameOuterSize(defaultProfile, 'landscape').width))
  })
})

/**
 * The searchable picker lives in its own overlay WebContentsView (the simulator
 * WCV would otherwise paint over a DOM dialog), so the toolbar button only asks
 * main to show it and the pick arrives back as an IPC push. Device state stays
 * owned here: the push takes the same path as a pick made in this window.
 */
describe('useDevice: the device-picker overlay', () => {
  it('opens the picker on whichever device is selected at that moment', () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEFAULT_DEVICE }))

    act(() => {
      result.current.handleDeviceChange(DEVICE_NAMES.Pixel_8)
    })
    act(() => {
      result.current.openDevicePicker()
    })

    expect(showDevicePicker).toHaveBeenLastCalledWith({ deviceName: DEVICE_NAMES.Pixel_8 })
  })

  it('applies the device the picker reports back and pushes it to the running mini-app', () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEFAULT_DEVICE }))

    firePicked(DEVICE_NAMES.Pixel_8)

    expect(result.current.device.name).toBe(DEVICE_NAMES.Pixel_8)
    expect(lastPayload()).toMatchObject({
      device: DEVICE_NAMES.Pixel_8,
      platform: 'android',
      orientation: 'portrait',
    })
  })

  it('unsubscribes on unmount so a later pick cannot reach a torn-down window', () => {
    const { unmount } = renderHook(() => useDevice({ initialDevice: DEFAULT_DEVICE }))
    expect(devicePickerHandlers).toHaveLength(1)

    unmount()

    expect(devicePickerHandlers).toHaveLength(0)
  })
})
