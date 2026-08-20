import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  listener: null as null | ((payload: { requestId: number; text: string; maxWidth: number }) => void),
  notifyOverlayReady: vi.fn(),
  reportTooltipMeasured: vi.fn(),
}))

vi.mock('@/shared/api', () => ({
  notifyOverlayReady: api.notifyOverlayReady,
  reportTooltipMeasured: api.reportTooltipMeasured,
  onTooltipInit: vi.fn((listener: typeof api.listener) => {
    api.listener = listener
    return () => { api.listener = null }
  }),
}))

import Tooltip from './tooltip'

afterEach(() => {
  vi.restoreAllMocks()
  api.listener = null
  api.notifyOverlayReady.mockReset()
  api.reportTooltipMeasured.mockReset()
})

describe('Tooltip renderer measurement', () => {
  it('announces readiness after subscribing and reports the active content size', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 93.2,
      bottom: 28.1,
      left: 0,
      width: 93.2,
      height: 28.1,
      toJSON: () => ({}),
    })
    render(<Tooltip />)

    expect(api.listener).not.toBeNull()
    expect(api.notifyOverlayReady).toHaveBeenCalledTimes(1)
    act(() => api.listener?.({ requestId: 7, text: '动态内容', maxWidth: 480 }))

    expect(screen.getByText('动态内容')).toBeInTheDocument()
    expect(api.reportTooltipMeasured).toHaveBeenLastCalledWith({
      requestId: 7,
      width: 94,
      height: 29,
    })
  })
})
