/**
 * Guards that useDevice's zoom state accepts the 'auto' sentinel alongside the
 * fixed ZOOM_OPTIONS percentages, and that handleZoomChange routes a select's
 * string value to the right branch (AUTO_ZOOM stays the sentinel, everything
 * else becomes a number).
 */
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type React from 'react'
import { AUTO_ZOOM } from '@/shared/constants'
import { DEFAULT_DEVICE } from '@devicekit/devices'
import { useDevice } from './use-device'

function changeEvent(value: string): React.ChangeEvent<HTMLSelectElement> {
  return { target: { value } } as React.ChangeEvent<HTMLSelectElement>
}

describe('useDevice: zoom accepts the auto-fit sentinel', () => {
  it('defaults to a fixed numeric zoom', () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEFAULT_DEVICE }))
    expect(result.current.zoom).toBe(85)
  })

  it('switches zoom to AUTO_ZOOM when the select value is "auto"', () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEFAULT_DEVICE }))

    act(() => {
      result.current.handleZoomChange(changeEvent(AUTO_ZOOM))
    })

    expect(result.current.zoom).toBe(AUTO_ZOOM)
  })

  it('switches zoom back to a number when a fixed percent is selected afterwards', () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEFAULT_DEVICE }))

    act(() => {
      result.current.handleZoomChange(changeEvent(AUTO_ZOOM))
    })
    act(() => {
      result.current.handleZoomChange(changeEvent('50'))
    })

    expect(result.current.zoom).toBe(50)
  })
})
