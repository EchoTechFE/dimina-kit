/**
 * SimulatorPanel's device/orientation pickers against the @devicekit/devices
 * table: the device <Select> is grouped by platform (iOS/Android/HarmonyOS)
 * and lists only the hand-picked CLASSIC_DEVICES subset (the full table is far
 * too long for a toolbar dropdown), each exactly once; a separate orientation
 * <Select> (portrait/landscape) reports changes via onOrientationChange.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import type { Placement } from '@dimina-kit/view-anchor'
import type { PlacementPublisher } from '@dimina-kit/electron-deck/client'
import { CLASSIC_DEVICES, DEFAULT_DEVICE, DEVICES } from '@devicekit/devices'
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

beforeEach(() => {
  cleanup()
})

describe('SimulatorPanel: device picker grouped by platform', () => {
  it('lists three optgroups labelled iOS / Android / HarmonyOS', () => {
    const { container } = render(panelElement())
    const groups = Array.from(container.querySelectorAll('optgroup'))
    expect(groups.map((g) => g.getAttribute('label')).sort()).toEqual(
      ['Android', 'HarmonyOS', 'iOS'].sort(),
    )
  })

  it('lists exactly the classic subset, each once, and not the full table', () => {
    const { container } = render(panelElement())
    const options = Array.from(container.querySelectorAll('optgroup option'), (o) => (o as HTMLOptionElement).value)
    expect(options).toEqual(CLASSIC_DEVICES.map((d) => d.name))
    expect(options.length).toBeLessThan(DEVICES.length)
  })

  it('puts each classic device under the optgroup of its own platform', () => {
    const { container } = render(panelElement())
    for (const group of Array.from(container.querySelectorAll('optgroup'))) {
      const os = { iOS: 'ios', Android: 'android', HarmonyOS: 'harmony' }[group.getAttribute('label') ?? '']
      for (const o of Array.from(group.querySelectorAll('option'))) {
        expect(CLASSIC_DEVICES.find((d) => d.name === o.value)?.os, o.value).toBe(os)
      }
    }
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
