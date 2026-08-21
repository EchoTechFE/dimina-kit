import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'

const api = vi.hoisted(() => ({
  showTooltip: vi.fn(),
  hideTooltip: vi.fn(),
}))

vi.mock('@/shared/api', () => api)

import { useOverlayTooltip } from './use-overlay-tooltip'

function Trigger({ label }: { label: string }) {
  return <button {...useOverlayTooltip(label)}>{label}</button>
}

function Harness({ showA = true }: { showA?: boolean }) {
  return (
    <>
      {showA && <Trigger label="A" />}
      <Trigger label="B" />
    </>
  )
}

afterEach(() => {
  vi.useRealTimers()
  api.showTooltip.mockReset()
  api.hideTooltip.mockReset()
})

describe('useOverlayTooltip ownership', () => {
  it('does not let an old trigger cleanup hide a newer tooltip', () => {
    vi.useFakeTimers()
    const view = render(<Harness />)

    fireEvent.mouseEnter(view.getByRole('button', { name: 'A' }))
    vi.advanceTimersByTime(400)
    fireEvent.mouseEnter(view.getByRole('button', { name: 'B' }))
    vi.advanceTimersByTime(400)
    expect(api.showTooltip).toHaveBeenCalledTimes(2)

    view.rerender(<Harness showA={false} />)
    expect(api.hideTooltip).not.toHaveBeenCalled()

    fireEvent.mouseLeave(view.getByRole('button', { name: 'B' }))
    expect(api.hideTooltip).toHaveBeenCalledTimes(1)
  })
})
