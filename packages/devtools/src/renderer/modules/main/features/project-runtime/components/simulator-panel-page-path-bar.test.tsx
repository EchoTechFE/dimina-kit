/**
 * SimulatorPanel page-path bar: shows the visible page's FULL route — path
 * plus query (`pages/detail/detail?id=42`) — exactly like WeChat DevTools'
 * simulator status bar, so a page's params are visible without opening the
 * compile popover. Regression guard for "the bottom of the simulator has no
 * place that shows params".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { PlacementPublisher } from '@dimina-kit/electron-deck/client'
import { PlacementPublisherContext } from '@/shared/placement-publisher-context'

vi.mock('@dimina-kit/view-anchor', () => ({
  createPlacementAnchor: () => ({ update: vi.fn(), dispose: vi.fn(), pulse: vi.fn() }),
}))

import { SimulatorPanel } from './simulator-panel'

const publisher = {
  set: vi.fn(),
  remove: vi.fn(),
  dispose: vi.fn(),
} as unknown as PlacementPublisher<{ zoom?: number }> & {
  set: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
}

function panel(currentPage: string) {
  const props: Parameters<typeof SimulatorPanel>[0] = {
    device: { name: 'iPhone 15', width: 393, height: 852 },
    zoom: 100,
    onDeviceChange: () => {},
    onZoomChange: () => {},
    compileStatus: { status: 'ready', message: '' },
    currentPage,
    copied: false,
    onCopyPagePath: () => {},
  }
  return (
    <PlacementPublisherContext.Provider value={publisher}>
      <SimulatorPanel {...props} />
    </PlacementPublisherContext.Provider>
  )
}

beforeEach(() => {
  cleanup()
  publisher.set.mockClear()
  publisher.remove.mockClear()
})

describe('SimulatorPanel: page-path bar shows the route with its params', () => {
  it('renders the full route (path + query) when the page has params', () => {
    const { getByText } = render(panel('pages/detail/detail?id=42&tag=hot'))
    expect(getByText('pages/detail/detail?id=42&tag=hot')).not.toBeNull()
  })

  it('keeps the full route in the title attribute (hover shows the un-truncated route)', () => {
    const { container } = render(panel('pages/detail/detail?id=42'))
    const span = container.querySelector('span[title]')
    expect(span?.getAttribute('title')).toBe('pages/detail/detail?id=42')
  })

  it('renders a bare path unchanged when the page has no params', () => {
    const { getByText } = render(panel('pages/index/index'))
    expect(getByText('pages/index/index')).not.toBeNull()
  })

  it('shows an em-dash placeholder when the route is unknown', () => {
    const { getByText } = render(panel(''))
    expect(getByText('—')).not.toBeNull()
  })
})
