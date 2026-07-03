/**
 * Contract: SimulatorPanel gains a `runtimeStatus: SessionRuntimeStatusPayload
 * | null` prop (main pushes it via onSessionRuntimeStatus — see
 * use-session-runtime-status.test.tsx). When the compile machine says
 * 'ready' but the session's RUNTIME machine landed on a terminal failure
 * (`launch-failed` / `crashed`), the panel must render a full-screen overlay
 * `[data-testid="sim-runtime-error"]` whose text includes the failure's
 * `reason` (or `code` when no reason was given) — today a launch timeout or a
 * service-host crash leaves the simulator region silently blank forever,
 * with the toolbar/page-path bar looking perfectly normal.
 *
 * `launching` / `running` / `null` must render NOTHING (a session mid-flight
 * or healthy is not an error). A COMPILE failure keeps its existing overlay
 * and takes priority — if both are true (rare: a stale runtime-status
 * lingering into a recompile-that-then-fails), only the compile error shows,
 * never both stacked.
 *
 * Harness: same view-anchor mock as simulator-panel-compiling-indicator.test.tsx
 * (createPlacementAnchor is unavailable under jsdom).
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

const publisher = {
  set: vi.fn(),
  remove: vi.fn(),
  dispose: vi.fn(),
} as unknown as PlacementPublisher<{ zoom?: number }> & {
  set: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
}

function panel(
  compileStatus: { status: string; message: string },
  runtimeStatus: SessionRuntimeStatusPayload | null,
) {
  const props: PanelPropsWithRuntime = {
    device: DEVICE,
    zoom: 100,
    onDeviceChange: () => {},
    onZoomChange: () => {},
    compileStatus,
    currentPage: 'pages/index/index',
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

describe('SimulatorPanel: runtime-error overlay for a terminal runtime failure', () => {
  it('renders nothing when runtimeStatus is null', () => {
    const { queryByTestId } = render(panel({ status: 'ready', message: '' }, null))
    expect(queryByTestId('sim-runtime-error')).toBeNull()
  })

  it('renders nothing while phase is "launching"', () => {
    const { queryByTestId } = render(panel({ status: 'ready', message: '' }, { appId: 'a', phase: 'launching' }))
    expect(queryByTestId('sim-runtime-error')).toBeNull()
  })

  it('renders nothing while phase is "running"', () => {
    const { queryByTestId } = render(panel({ status: 'ready', message: '' }, { appId: 'a', phase: 'running' }))
    expect(queryByTestId('sim-runtime-error')).toBeNull()
  })

  it('renders the overlay with the reason text for phase "launch-failed"', () => {
    const { queryByTestId, getByTestId } = render(
      panel(
        { status: 'ready', message: '' },
        { appId: 'a', phase: 'launch-failed', code: 'timeout', reason: 'Service host did not report readiness within 20000ms' },
      ),
    )
    expect(queryByTestId('sim-runtime-error')).not.toBeNull()
    expect(getByTestId('sim-runtime-error').textContent).toContain('Service host did not report readiness within 20000ms')
  })

  it('renders the overlay with the code text for phase "crashed" when no reason was given', () => {
    const { queryByTestId, getByTestId } = render(
      panel({ status: 'ready', message: '' }, { appId: 'a', phase: 'crashed', code: 'service-host-crashed' }),
    )
    expect(queryByTestId('sim-runtime-error')).not.toBeNull()
    expect(getByTestId('sim-runtime-error').textContent).toContain('service-host-crashed')
  })

  it('a compile "error" wins priority — the runtime overlay must not ALSO render when both are true', () => {
    const { queryByTestId, getByText } = render(
      panel(
        { status: 'error', message: 'compile boom' },
        { appId: 'a', phase: 'crashed', code: 'service-host-crashed' },
      ),
    )
    expect(getByText('编译失败')).not.toBeNull()
    expect(
      queryByTestId('sim-runtime-error'),
      'the compile-error overlay must be the ONLY overlay shown — never stacked with the runtime overlay',
    ).toBeNull()
  })
})
