/**
 * Guards that SimulatorPanel collapses its native WebContentsView when its
 * kept-alive DOM tab deactivates.
 *
 * Under DOM-panel keepalive, DockView keeps an inactive panel's body mounted in
 * a `display:none` wrapper. SimulatorPanel binds its placement anchor with
 * `guardDisplayNone: true`, which installs an IntersectionObserver that re-fires
 * on a display:none transition (invisible to ResizeObserver) and turns the
 * zero-area measure into a `{ visible:false }` publish. The component maps that
 * hidden placement to `publisher.set({ viewId: simulator, placement: { visible:
 * false } })` — the discriminated placement is kept end-to-end (no 0×0 flatten);
 * the main reconciler turns it into setVisible(false).
 *
 * A true behavioral test (toggle display:none → assert hidden) is not feasible
 * in jsdom: the guard needs real getBoundingClientRect geometry and a real
 * IntersectionObserver, neither of which jsdom provides (that path is covered by
 * view-anchor's own suite). The discriminating fact for THIS component is that
 * it opts into the guard and maps a hidden placement to a hidden publisher
 * write, so we assert both.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { Placement } from '@dimina-kit/view-anchor'
import type { PlacementPublisher } from '@dimina-kit/electron-deck/client'
import { PlacementPublisherContext } from '../placement-publisher-context'
import { VIEW_ID } from '../../../../../../shared/view-ids'

// view-anchor mock: capture every createPlacementAnchor call so we can inspect
// its options AND drive its `publish` callback by hand (the real guard path
// needs geometry + IntersectionObserver jsdom lacks — see header).
const anchorCalls = vi.hoisted(
  () => [] as Array<{
    el: HTMLElement
    opts: { visible: boolean; followGeometry?: boolean; guardDisplayNone?: boolean; publish: (p: Placement) => void }
  }>,
)
vi.mock('@dimina-kit/view-anchor', () => ({
  createPlacementAnchor: (
    el: HTMLElement,
    opts: { visible: boolean; followGeometry?: boolean; guardDisplayNone?: boolean; publish: (p: Placement) => void },
  ) => {
    anchorCalls.push({ el, opts })
    return { update: vi.fn(), dispose: vi.fn(), pulse: vi.fn() }
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

function renderPanel() {
  return render(
    <PlacementPublisherContext.Provider value={publisher}>
      <SimulatorPanel
        device={DEVICE}
        zoom={100}
        onDeviceChange={() => {}}
        onZoomChange={() => {}}
        compileStatus={{ status: 'ready', message: '' }}
        currentPage="pages/index/index"
        copied={false}
        onCopyPagePath={() => {}}
      />
    </PlacementPublisherContext.Provider>,
  )
}

beforeEach(() => {
  cleanup()
  anchorCalls.length = 0
  publisher.set.mockClear()
  publisher.remove.mockClear()
})

describe('SimulatorPanel: collapse native view when its kept-alive slot deactivates', () => {
  it('binds the placement anchor with guardDisplayNone: true', () => {
    renderPanel()

    expect(anchorCalls.length).toBeGreaterThanOrEqual(1)
    const bind = anchorCalls[0]!
    expect(bind.el.getAttribute('data-area')).toBe('native-simulator')

    // Opts into the display:none guard, and preserves geometry-follow.
    expect(bind.opts.guardDisplayNone).toBe(true)
    expect(bind.opts.followGeometry).toBe(true)
  })

  it('writes a hidden placement to the publisher when its anchor reports hidden', () => {
    renderPanel()

    const bind = anchorCalls[0]!
    publisher.set.mockClear()

    // Drive the anchor's publish with a HIDDEN placement (what guardDisplayNone
    // emits on a display:none transition).
    bind.opts.publish({ visible: false } as Placement)

    expect(publisher.set).toHaveBeenCalledTimes(1)
    const arg = publisher.set.mock.calls[0]![0] as { viewId: string; placement: Placement }
    expect(arg.viewId).toBe(VIEW_ID.simulator)
    // Discriminated placement kept end-to-end — NOT flattened to a 0×0 rect.
    expect(arg.placement).toEqual({ visible: false })
  })
})
