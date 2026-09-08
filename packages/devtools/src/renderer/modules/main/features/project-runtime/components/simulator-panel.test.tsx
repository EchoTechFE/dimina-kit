/**
 * SimulatorPanel's device and zoom controls. The device control is a button
 * showing the current device name; the searchable list itself lives in the
 * device-picker overlay WebContentsView, because the simulator's own WCV is
 * painted over this panel and would cut a centred dialog in half. So the panel
 * only reports the click through `onOpenDevicePicker` and must render no device
 * options of its own.
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
  onOpenDevicePicker: () => void = () => {},
) {
  return (
    <PlacementPublisherContext.Provider value={publisher}>
      <SimulatorPanel
        device={DEFAULT_DEVICE}
        zoom={85}
        onOpenDevicePicker={onOpenDevicePicker}
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
    render(panelElement(onOpenDevicePicker))

    fireEvent.click(screen.getByRole('button', { name: DEFAULT_DEVICE.name }))

    expect(onOpenDevicePicker).toHaveBeenCalledTimes(1)
    // The device list belongs to the overlay view. A dialog or device rows
    // rendered here would be painted behind the simulator WCV — the options
    // still present in this DOM is the zoom <select>.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('option', { name: DEVICE_NAMES.iPad_Pro_13 })).toBeNull()
  })
})

describe('SimulatorPanel: fixed portrait simulation', () => {
  it('does not render orientation options while preserving device selection and zoom', () => {
    render(panelElement())

    expect(screen.queryByRole('option', { name: '竖屏' })).toBeNull()
    expect(screen.queryByRole('option', { name: '横屏' })).toBeNull()
    expect(screen.getByRole('button', { name: DEFAULT_DEVICE.name })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '85%' })).toBeInTheDocument()
  })
})
