/**
 * Guards SimulatorPanel's auto-fit zoom: when 'auto' is selected, the zoom
 * percent published to the placement publisher is derived from the
 * device-region box measured by the EXISTING placement anchor (no new
 * listener), capped at 100, and stops following once switched back to a
 * fixed percent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { Placement } from '@dimina-kit/view-anchor'
import type { PlacementPublisher } from '@dimina-kit/electron-deck/client'
import { PlacementPublisherContext } from '../placement-publisher-context'
import { AUTO_ZOOM, type ZoomSetting } from '@/shared/constants'

interface AnchorHandle {
  update: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  pulse: ReturnType<typeof vi.fn>
}
const anchorCalls = vi.hoisted(
  () => [] as Array<{
    el: HTMLElement
    opts: { visible: boolean; followGeometry?: boolean; guardDisplayNone?: boolean; publish: (p: Placement) => void }
    handle: AnchorHandle
  }>,
)
vi.mock('@dimina-kit/view-anchor', () => ({
  createPlacementAnchor: (
    el: HTMLElement,
    opts: { visible: boolean; followGeometry?: boolean; guardDisplayNone?: boolean; publish: (p: Placement) => void },
  ) => {
    const handle: AnchorHandle = { update: vi.fn(), dispose: vi.fn(), pulse: vi.fn() }
    anchorCalls.push({ el, opts, handle })
    return handle
  },
}))

import { SimulatorPanel } from './simulator-panel'

const DEVICE = { name: 'iPhone X', width: 375, height: 812 }

const publisher = {
  set: vi.fn(),
  remove: vi.fn(),
  dispose: vi.fn(),
} as unknown as PlacementPublisher<{ zoom?: number }> & {
  set: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
}

function panelElement(zoom: ZoomSetting, device: typeof DEVICE = DEVICE) {
  return (
    <PlacementPublisherContext.Provider value={publisher}>
      <SimulatorPanel
        device={device}
        zoom={zoom}
        onDeviceChange={() => {}}
        onZoomChange={() => {}}
        compileStatus={{ status: 'ready', message: '' }}
        currentPage="pages/index/index"
        copied={false}
        onCopyPagePath={() => {}}
      />
    </PlacementPublisherContext.Provider>
  )
}

function lastZoom(): number | undefined {
  const calls = publisher.set.mock.calls
  const last = calls[calls.length - 1]![0] as { extra?: { zoom?: number } }
  return last.extra?.zoom
}

beforeEach(() => {
  cleanup()
  anchorCalls.length = 0
  publisher.set.mockClear()
  publisher.remove.mockClear()
})

describe('SimulatorPanel: auto-fit zoom', () => {
  it('renders an "自适应" option in the zoom dropdown', () => {
    const { container } = render(panelElement(85))
    const option = container.querySelector('option[value="auto"]')
    expect(option).not.toBeNull()
    expect(option?.textContent).toBe('自适应')
  })

  it('reserves the shell frame and rounds down so the device never overflows', () => {
    const { container } = render(panelElement(AUTO_ZOOM))
    const bind = anchorCalls[0]!
    publisher.set.mockClear()

    bind.opts.publish({
      visible: true,
      bounds: { x: 0, y: 0, width: DEVICE.width, height: DEVICE.height },
    })

    // The DeviceShell desk contributes 24px padding on both sides and the
    // handset has a 1px border on both edges. 88% is the largest whole percent
    // that keeps the complete framed handset inside this 375x812 region.
    expect(lastZoom()).toBe(88)

    const zoomSelect = container.querySelectorAll('select')[1]
    expect(zoomSelect?.className).toContain('w-[76px]')
    expect(zoomSelect?.className).not.toContain('h-8')
    expect(zoomSelect?.className).not.toContain('text-[14px]')
  })

  it('derives the zoom percent from the measured box when auto is selected', () => {
    render(panelElement(AUTO_ZOOM))
    const bind = anchorCalls[0]!
    publisher.set.mockClear()

    // The desk frame leaves a 44% whole-percent fit for a half-size region.
    bind.opts.publish({
      visible: true,
      bounds: { x: 0, y: 0, width: DEVICE.width / 2, height: DEVICE.height / 2 },
    })

    expect(lastZoom()).toBe(44)
  })

  it('recomputes on every re-measure without any additional listener', () => {
    render(panelElement(AUTO_ZOOM))
    const bind = anchorCalls[0]!

    bind.opts.publish({
      visible: true,
      bounds: { x: 0, y: 0, width: DEVICE.width / 2, height: DEVICE.height / 2 },
    })
    expect(lastZoom()).toBe(44)

    // Panel widened — the SAME publish callback (no new observer) re-derives.
    bind.opts.publish({
      visible: true,
      bounds: { x: 0, y: 0, width: DEVICE.width, height: DEVICE.height },
    })
    expect(lastZoom()).toBe(88)
  })

  it('caps the computed zoom at 100 even when the box is far larger than the device', () => {
    render(panelElement(AUTO_ZOOM))
    const bind = anchorCalls[0]!

    bind.opts.publish({
      visible: true,
      bounds: { x: 0, y: 0, width: DEVICE.width * 3, height: DEVICE.height * 3 },
    })

    expect(lastZoom()).toBe(100)
  })

  it('stops following the box once switched back to a fixed percent', () => {
    const { rerender } = render(panelElement(AUTO_ZOOM))
    const bind = anchorCalls[0]!
    bind.opts.publish({
      visible: true,
      bounds: { x: 0, y: 0, width: DEVICE.width / 2, height: DEVICE.height / 2 },
    })
    expect(lastZoom()).toBe(44)

    rerender(panelElement(75))

    // A resize after switching back must NOT recompute — it stays at the fixed 75.
    bind.opts.publish({
      visible: true,
      bounds: { x: 0, y: 0, width: DEVICE.width * 3, height: DEVICE.height * 3 },
    })
    expect(lastZoom()).toBe(75)
  })

  it('falls back to the last resolved zoom on a zero-size measurement', () => {
    render(panelElement(AUTO_ZOOM))
    const bind = anchorCalls[0]!

    bind.opts.publish({
      visible: true,
      bounds: { x: 0, y: 0, width: DEVICE.width / 2, height: DEVICE.height / 2 },
    })
    expect(lastZoom()).toBe(44)

    bind.opts.publish({ visible: true, bounds: { x: 0, y: 0, width: 0, height: 0 } })
    expect(lastZoom()).toBe(44)
  })

  it('recomputes against the new device size after switching devices while auto is selected', () => {
    const { rerender } = render(panelElement(AUTO_ZOOM))
    const bind = anchorCalls[0]!

    // The original device plus its desk frame fits this box at 88%.
    bind.opts.publish({
      visible: true,
      bounds: { x: 0, y: 0, width: DEVICE.width, height: DEVICE.height },
    })
    expect(lastZoom()).toBe(88)

    // Switch to a device twice as wide/tall — the same box now only fits it at 46%.
    const BIGGER_DEVICE = { name: 'iPhone 16 Pro Max (test double)', width: DEVICE.width * 2, height: DEVICE.height * 2 }
    rerender(
      <PlacementPublisherContext.Provider value={publisher}>
        <SimulatorPanel
          device={BIGGER_DEVICE}
          zoom={AUTO_ZOOM}
          onDeviceChange={() => {}}
          onZoomChange={() => {}}
          compileStatus={{ status: 'ready', message: '' }}
          currentPage="pages/index/index"
          copied={false}
          onCopyPagePath={() => {}}
        />
      </PlacementPublisherContext.Provider>,
    )
    bind.opts.publish({
      visible: true,
      bounds: { x: 0, y: 0, width: DEVICE.width, height: DEVICE.height },
    })
    expect(lastZoom()).toBe(46)
  })

  it('calls update() to force a re-measure when switching between same-width devices while auto is selected', () => {
    const { rerender } = render(panelElement(AUTO_ZOOM))
    const anchor = anchorCalls[0]!
    anchor.handle.update.mockClear()

    // iPhone SE and iPhone X are both 375 wide but a different height — a
    // pure height change that computeSimPanelWidth (width-only) would NOT
    // turn into a panel-width change, so the geometry ResizeObserver alone
    // cannot be relied on to trigger a re-measure. The zoom-effect's
    // dependency array must include `device` so update() is still forced.
    const SAME_WIDTH_SHORTER_DEVICE = { name: 'iPhone SE', width: DEVICE.width, height: 667 }
    rerender(panelElement(AUTO_ZOOM, SAME_WIDTH_SHORTER_DEVICE))

    expect(anchor.handle.update).toHaveBeenCalled()
  })
})
