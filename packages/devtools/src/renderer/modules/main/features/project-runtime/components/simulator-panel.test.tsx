/**
 * SimulatorPanel's device/orientation controls. The device control is a button
 * showing the current device name; the searchable list itself lives in the
 * device-picker overlay WebContentsView, because the simulator's own WCV is
 * painted over this panel and would cut a centred dialog in half. So the panel
 * only reports the click through `onOpenDevicePicker` and must render no device
 * options of its own. A separate orientation <Select> (portrait/landscape)
 * reports changes via onOrientationChange.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
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

function panelElement(
  onOrientationChange: (o: 'portrait' | 'landscape') => void = () => {},
  onOpenDevicePicker: () => void = () => {},
) {
  return (
    <PlacementPublisherContext.Provider value={publisher}>
      <SimulatorPanel
        device={DEFAULT_DEVICE}
        orientation="portrait"
        zoom={85}
        onOpenDevicePicker={onOpenDevicePicker}
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

beforeEach(() => {
  cleanup()
})

describe('SimulatorPanel: device picker trigger', () => {
  it('renders a button showing the current device name instead of a native <select>', () => {
    const { container } = render(panelElement())

    expect(screen.getByRole('button', { name: DEFAULT_DEVICE.name })).toBeInTheDocument()
    expect(container.querySelector('select option[value="' + DEFAULT_DEVICE.name + '"]')).toBeNull()
  })

  it('reports the click to the device-state owner and renders no device list of its own', () => {
    const onOpenDevicePicker = vi.fn()
    render(panelElement(() => {}, onOpenDevicePicker))

    fireEvent.click(screen.getByRole('button', { name: DEFAULT_DEVICE.name }))

    expect(onOpenDevicePicker).toHaveBeenCalledTimes(1)
    // The device list belongs to the overlay view. A dialog or device rows
    // rendered here would be painted behind the simulator WCV — the options
    // still present in this DOM are the orientation/zoom <select>s'.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('option', { name: DEVICE_NAMES.iPad_Pro_13 })).toBeNull()
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
