/**
 * Guards that useDevice's zoom state accepts the 'auto' sentinel alongside the
 * fixed ZOOM_OPTIONS percentages, and that handleZoomChange routes a select's
 * string value to the right branch (AUTO_ZOOM stays the sentinel, everything
 * else becomes a number).
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type React from 'react'
import { AUTO_ZOOM, DEVICES } from '@/shared/constants'

// useDevice mounts a session-orientation subscription, reads back main's cached device orientation, and can push device info over the preload IPC bridge — none of which exist in this bridge-free unit test.
// Stub all three so mounting the hook doesn't throw; getNativeDeviceInfo resolves null (no cached device) so the gate opens immediately with the portrait default.
vi.mock('@/shared/api', () => ({
  setNativeDeviceInfo: vi.fn(async () => {}),
  getNativeDeviceInfo: vi.fn(async () => null),
  onSessionOrientationChanged: vi.fn(() => () => {}),
}))

import { useDevice } from './use-device'

function changeEvent(value: string): React.ChangeEvent<HTMLSelectElement> {
  return { target: { value } } as React.ChangeEvent<HTMLSelectElement>
}

describe('useDevice: zoom accepts the auto-fit sentinel', () => {
  it('defaults to a fixed numeric zoom', () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEVICES[1]! }))
    expect(result.current.zoom).toBe(85)
  })

  it('switches zoom to AUTO_ZOOM when the select value is "auto"', () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEVICES[1]! }))

    act(() => {
      result.current.handleZoomChange(changeEvent(AUTO_ZOOM))
    })

    expect(result.current.zoom).toBe(AUTO_ZOOM)
  })

  it('switches zoom back to a number when a fixed percent is selected afterwards', () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEVICES[1]! }))

    act(() => {
      result.current.handleZoomChange(changeEvent(AUTO_ZOOM))
    })
    act(() => {
      result.current.handleZoomChange(changeEvent('50'))
    })

    expect(result.current.zoom).toBe(50)
  })
})
