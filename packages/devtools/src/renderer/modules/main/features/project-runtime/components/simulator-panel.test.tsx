/**
 * SimulatorPanel's device/orientation pickers against the @devicekit/devices
 * table: the device picker is a button showing the current device name that
 * opens DevicePicker's searchable panel over the FULL DEVICES table (not
 * just CLASSIC_DEVICES — DevicePicker owns that distinction now), so
 * non-classic devices like 'iPad Pro 13' must be reachable from here too. A
 * separate orientation <Select> (portrait/landscape) reports changes via
 * onOrientationChange.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { Placement } from '@dimina-kit/view-anchor'
import type { PlacementPublisher } from '@dimina-kit/electron-deck/client'
import { DEFAULT_DEVICE, DEVICE_NAMES } from '@devicekit/devices'
import { PlacementPublisherContext } from '@/shared/placement-publisher-context'

interface AnchorHandle {
  update: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  pulse: ReturnType<typeof vi.fn>
}
vi.mock('@dimina-kit/view-anchor', () => ({
  createPlacementAnchor: (
    _el: HTMLElement,
    _opts: { visible: boolean; followGeometry?: boolean; guardDisplayNone?: boolean; publish: (p: Placement) => void },
  ): AnchorHandle => ({ update: vi.fn(), dispose: vi.fn(), pulse: vi.fn() }),
}))

import { SimulatorPanel } from './simulator-panel'

const publisher = {
  set: vi.fn(),
  remove: vi.fn(),
  dispose: vi.fn(),
} as unknown as PlacementPublisher<{ zoom?: number }>

function panelElement(onOrientationChange: (o: 'portrait' | 'landscape') => void = () => {}) {
  return (
    <PlacementPublisherContext.Provider value={publisher}>
      <SimulatorPanel
        device={DEFAULT_DEVICE}
        orientation="portrait"
        zoom={85}
        onDeviceChange={() => {}}
        onOrientationChange={onOrientationChange}
        onZoomChange={() => {}}
        compileStatus={{ status: 'ready', message: '' }}
        currentPage="pages/index/index"
        copied={false}
        onCopyPagePath={() => {}}
      />
    </PlacementPublisherContext.Provider>
  )
}

// cmdk (inside DevicePicker) measures its list via ResizeObserver, which
// jsdom does not implement.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  cleanup()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SimulatorPanel: device picker trigger', () => {
  it('renders a button showing the current device name instead of a native <select>', () => {
    const { container } = render(panelElement())

    expect(screen.getByRole('button', { name: DEFAULT_DEVICE.name })).toBeInTheDocument()
    expect(container.querySelector('select option[value="' + DEFAULT_DEVICE.name + '"]')).toBeNull()
  })

  it('opens DevicePicker over the full DEVICES table, reaching non-classic devices like iPad Pro 13', async () => {
    render(panelElement())

    fireEvent.click(screen.getByRole('button', { name: DEFAULT_DEVICE.name }))

    expect(await screen.findByRole('option', { name: DEVICE_NAMES.iPad_Pro_13 })).toBeInTheDocument()
  })
})

describe('SimulatorPanel: orientation picker', () => {
  function findOrientationSelect(container: HTMLElement): HTMLSelectElement | undefined {
    return Array.from(container.querySelectorAll('select')).find(
      (el) =>
        el.querySelector('option[value="portrait"]') &&
        el.querySelector('option[value="landscape"]'),
    )
  }

  it('renders a select offering portrait and landscape', () => {
    const { container } = render(panelElement())
    const select = findOrientationSelect(container)
    expect(select).toBeTruthy()
  })

  it('reports the new orientation via onOrientationChange', () => {
    const onOrientationChange = vi.fn()
    const { container } = render(panelElement(onOrientationChange))
    const select = findOrientationSelect(container)!

    fireEvent.change(select, { target: { value: 'landscape' } })

    expect(onOrientationChange).toHaveBeenCalledWith('landscape')
  })
})
