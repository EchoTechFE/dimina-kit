/**
 * Contract: SimulatorPanel renders a non-blocking fallback banner
 * `[data-testid="sim-fallback-banner"]` whenever `runtimeStatus.pageFallback`
 * is present AND the session is not in a terminal failure — the developer's
 * configured start page didn't exist and main silently redirected to a
 * different one; without a banner this looks like the app just launched on
 * an unexpected page with no explanation.
 *
 * The banner must show BOTH the requested and the resolved page paths (the
 * whole point is telling the developer what changed). It must NOT render
 * when there is no `pageFallback`, and must NOT render when the phase is a
 * terminal failure (`launch-failed`/`crashed`) even if a fallback was
 * recorded earlier in the same session — the blocking error overlay already
 * owns that state, a non-blocking banner underneath it would be redundant/
 * confusing chrome.
 *
 * Harness: identical view-anchor mock to
 * simulator-panel-runtime-error-overlay.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { PlacementPublisher } from '@dimina-kit/electron-deck/client'
import type { SessionRuntimeStatusPayload } from '@/shared/api'
import { PlacementPublisherContext } from '../placement-publisher-context'

vi.mock('@dimina-kit/view-anchor', () => ({
  createPlacementAnchor: () => ({ update: vi.fn(), dispose: vi.fn(), pulse: vi.fn() }),
}))

import { SimulatorPanel } from './simulator-panel'

type PanelPropsWithRuntime = Parameters<typeof SimulatorPanel>[0] & {
  runtimeStatus: SessionRuntimeStatusPayload | null
}

const DEVICE = { name: 'iPhone X', width: 375, height: 812 }
const REQUESTED = 'pages/removed/removed'
const RESOLVED = 'pages/index/index'

const publisher = {
  set: vi.fn(),
  remove: vi.fn(),
  dispose: vi.fn(),
} as unknown as PlacementPublisher<{ zoom?: number }> & {
  set: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
}

function panel(runtimeStatus: SessionRuntimeStatusPayload | null) {
  const props: PanelPropsWithRuntime = {
    device: DEVICE,
    zoom: 100,
    onDeviceChange: () => {},
    onZoomChange: () => {},
    compileStatus: { status: 'ready', message: '' },
    currentPage: RESOLVED,
    copied: false,
    onCopyPagePath: () => {},
    runtimeStatus,
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

describe('SimulatorPanel: fallback banner for a redirected start page', () => {
  it('does not render when runtimeStatus is null', () => {
    const { queryByTestId } = render(panel(null))
    expect(queryByTestId('sim-fallback-banner')).toBeNull()
  })

  it('does not render when there is no pageFallback (normal launch)', () => {
    const { queryByTestId } = render(panel({ appId: 'a', phase: 'running' }))
    expect(queryByTestId('sim-fallback-banner')).toBeNull()
  })

  it('renders with both the requested and resolved paths while phase is "running"', () => {
    const { getByTestId } = render(
      panel({ appId: 'a', phase: 'running', pageFallback: { requested: REQUESTED, resolved: RESOLVED } }),
    )
    const banner = getByTestId('sim-fallback-banner')
    expect(banner.textContent).toContain(REQUESTED)
    expect(banner.textContent).toContain(RESOLVED)
  })

  it('renders while phase is "launching" too (non-terminal states show the banner)', () => {
    const { queryByTestId } = render(
      panel({ appId: 'a', phase: 'launching', pageFallback: { requested: REQUESTED, resolved: RESOLVED } }),
    )
    expect(queryByTestId('sim-fallback-banner')).not.toBeNull()
  })

  it('does NOT render when phase is a terminal failure ("launch-failed"), even with a recorded pageFallback', () => {
    const { queryByTestId } = render(
      panel({
        appId: 'a',
        phase: 'launch-failed',
        code: 'timeout',
        pageFallback: { requested: REQUESTED, resolved: RESOLVED },
      }),
    )
    expect(
      queryByTestId('sim-fallback-banner'),
      'the blocking runtime-error overlay already owns this state — a redundant banner underneath it must not render',
    ).toBeNull()
  })

  it('does NOT render when phase is "crashed", even with a recorded pageFallback', () => {
    const { queryByTestId } = render(
      panel({
        appId: 'a',
        phase: 'crashed',
        code: 'service-host-crashed',
        pageFallback: { requested: REQUESTED, resolved: RESOLVED },
      }),
    )
    expect(queryByTestId('sim-fallback-banner')).toBeNull()
  })
})
