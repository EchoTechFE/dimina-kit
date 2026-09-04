/**
 * useDevice against the @devicekit/devices contract: device selection and
 * orientation both drive a single NativeDeviceInfo push (`setNativeDeviceInfo`),
 * and simPanelWidth tracks the framed (bezel-inclusive) size for the current
 * device/orientation pair rather than the bare screen width.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type React from 'react'
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

vi.mock('@/shared/api', () => ({
  setNativeDeviceInfo: vi.fn(),
}))

import { setNativeDeviceInfo } from '@/shared/api'

function changeEvent(value: string): React.ChangeEvent<HTMLSelectElement> {
  return { target: { value } } as React.ChangeEvent<HTMLSelectElement>
}

function lastPayload() {
  const calls = vi.mocked(setNativeDeviceInfo).mock.calls
  return calls[calls.length - 1]![0]
}

beforeEach(() => {
  vi.mocked(setNativeDeviceInfo).mockClear()
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
      result.current.handleDeviceChange(changeEvent(DEVICE_NAMES.Pixel_8))
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
      result.current.handleDeviceChange(changeEvent(DEVICE_NAMES.iPhone_15))
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
      result.current.handleDeviceChange(changeEvent('Definitely Not A Real Phone'))
    })

    expect(result.current.device).toBe(DEFAULT_DEVICE)
  })
})

describe('useDevice: simPanelWidth follows the framed (bezel-inclusive) size', () => {
  it('recomputes simPanelWidth from frameOuterSize on device change', () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEFAULT_DEVICE }))
    const pixel8Profile = findDevice(DEVICE_NAMES.Pixel_8)!

    act(() => {
      result.current.handleDeviceChange(changeEvent(DEVICE_NAMES.Pixel_8))
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
