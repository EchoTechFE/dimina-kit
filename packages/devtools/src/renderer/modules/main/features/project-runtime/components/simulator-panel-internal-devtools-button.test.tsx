/**
 * Contract: SimulatorPanel renders a bottom-toolbar "debug" icon button
 * `[data-testid="sim-open-internal-devtools"]` that opens the main window's
 * detached Chrome DevTools (Phase 0 of the standalone floating CDP debug
 * panel). Unlike the page-path copy button, this button debugs the whole
 * app rather than the current page, so it must render UNCONDITIONALLY —
 * even when `currentPage` is empty and the copy button is absent.
 *
 * Clicking it calls the `onOpenInternalDevtools` prop; when the prop is
 * omitted it must fall back to a no-op (same pattern as `onRelaunch`), so a
 * click never throws.
 *
 * Harness: identical view-anchor mock to simulator-panel-fallback-banner.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import type { PlacementPublisher } from '@dimina-kit/electron-deck/client'
import { PlacementPublisherContext } from '../placement-publisher-context'

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

function panel(overrides: {
  currentPage?: string
  onOpenInternalDevtools?: () => void
} = {}) {
  const props: Parameters<typeof SimulatorPanel>[0] = {
    device: DEVICE,
    zoom: 100,
    onDeviceChange: () => {},
    onZoomChange: () => {},
    compileStatus: { status: 'ready', message: '' },
    currentPage: overrides.currentPage ?? '',
    copied: false,
    onCopyPagePath: () => {},
    ...(overrides.onOpenInternalDevtools
      ? { onOpenInternalDevtools: overrides.onOpenInternalDevtools }
      : {}),
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

describe('SimulatorPanel: internal-devtools debug button', () => {
  it('renders even when currentPage is empty (app-wide debug is independent of the current page path)', () => {
    const { getByTestId } = render(panel({ currentPage: '' }))
    expect(getByTestId('sim-open-internal-devtools')).not.toBeNull()
  })

  it('renders when currentPage is set too', () => {
    const { getByTestId } = render(panel({ currentPage: 'pages/index/index' }))
    expect(getByTestId('sim-open-internal-devtools')).not.toBeNull()
  })

  it('clicking the button calls the onOpenInternalDevtools prop', () => {
    const onOpenInternalDevtools = vi.fn()
    const { getByTestId } = render(panel({ onOpenInternalDevtools }))

    fireEvent.click(getByTestId('sim-open-internal-devtools'))

    expect(onOpenInternalDevtools).toHaveBeenCalledTimes(1)
  })

  it('clicking the button without an onOpenInternalDevtools prop does not throw (defaults to a no-op)', () => {
    const { getByTestId } = render(panel())

    expect(() => fireEvent.click(getByTestId('sim-open-internal-devtools'))).not.toThrow()
  })
})
