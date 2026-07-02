/**
 * Guards that SimulatorPanel distinguishes first-compile from recompile.
 *
 * On first compile (never yet reached `ready`), a `compiling` status must
 * render a full-screen blocking overlay (`sim-compiling-overlay`) over the
 * device region, since there is no prior frame to show underneath.
 *
 * On a recompile (the panel has rendered `ready` at least once before), a
 * `compiling` status must NOT render that blocking overlay again — the old
 * phone/device content stays visible — and instead renders a non-blocking
 * `sim-recompiling-indicator`.
 *
 * `ready` renders neither testid; `error` keeps the existing error overlay
 * and also renders neither of the two compiling testids.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { PlacementPublisher } from '@dimina-kit/electron-deck/client'
import { PlacementPublisherContext } from '../placement-publisher-context'

// Same view-anchor mock harness as simulator-panel-collapse-on-deactivate.test.tsx:
// SimulatorPanel binds an imperative placement anchor on mount, which is not
// available in jsdom, so createPlacementAnchor is stubbed out entirely.
vi.mock('@dimina-kit/view-anchor', () => ({
  createPlacementAnchor: () => ({ update: vi.fn(), dispose: vi.fn(), pulse: vi.fn() }),
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

function panel(compileStatus: { status: string; message: string }) {
  return (
    <PlacementPublisherContext.Provider value={publisher}>
      <SimulatorPanel
        device={DEVICE}
        zoom={100}
        onDeviceChange={() => {}}
        onZoomChange={() => {}}
        compileStatus={compileStatus}
        currentPage="pages/index/index"
        copied={false}
        onCopyPagePath={() => {}}
      />
    </PlacementPublisherContext.Provider>
  )
}

beforeEach(() => {
  cleanup()
  publisher.set.mockClear()
  publisher.remove.mockClear()
})

describe('SimulatorPanel: first-compile vs recompile indicator', () => {
  it('first compile (never reached ready) renders the full-screen blocking overlay, not the recompile indicator', () => {
    const { queryByTestId } = render(panel({ status: 'compiling', message: '' }))

    expect(queryByTestId('sim-compiling-overlay')).not.toBeNull()
    expect(queryByTestId('sim-recompiling-indicator')).toBeNull()
  })

  it('recompile (compiling again after having reached ready) renders the non-blocking indicator, not the full-screen overlay', () => {
    const { queryByTestId, rerender } = render(panel({ status: 'ready', message: '' }))

    // No compiling markers while ready.
    expect(queryByTestId('sim-compiling-overlay')).toBeNull()
    expect(queryByTestId('sim-recompiling-indicator')).toBeNull()

    rerender(panel({ status: 'compiling', message: '' }))

    expect(queryByTestId('sim-compiling-overlay')).toBeNull()
    expect(queryByTestId('sim-recompiling-indicator')).not.toBeNull()
  })

  it('ready renders neither the blocking overlay nor the recompile indicator', () => {
    const { queryByTestId } = render(panel({ status: 'ready', message: '' }))

    expect(queryByTestId('sim-compiling-overlay')).toBeNull()
    expect(queryByTestId('sim-recompiling-indicator')).toBeNull()
  })

  it('error renders the existing error overlay and neither compiling testid', () => {
    const { queryByTestId, getByText } = render(
      panel({ status: 'error', message: 'boom' }),
    )

    expect(getByText('编译失败')).not.toBeNull()
    expect(queryByTestId('sim-compiling-overlay')).toBeNull()
    expect(queryByTestId('sim-recompiling-indicator')).toBeNull()
  })

  it('a recompile that later returns to ready clears the recompile indicator', () => {
    const { queryByTestId, rerender } = render(panel({ status: 'ready', message: '' }))

    rerender(panel({ status: 'compiling', message: '' }))
    expect(queryByTestId('sim-recompiling-indicator')).not.toBeNull()

    rerender(panel({ status: 'ready', message: '' }))
    expect(queryByTestId('sim-compiling-overlay')).toBeNull()
    expect(queryByTestId('sim-recompiling-indicator')).toBeNull()
  })
})
