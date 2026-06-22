/**
 * Settings overlay — outside-click-to-close contract.
 *
 * The settings overlay is a full-content-area WebContentsView. To get
 * click-outside-to-close (like the compile popover), the `Settings` component
 * must render a TRANSPARENT BACKDROP covering the whole area, plus the actual
 * 320px panel on the right. Clicking the backdrop closes the overlay; clicking
 * inside the panel does NOT (the panel stops propagation).
 *
 * Target file: `src/renderer/modules/settings/settings.tsx`, `export default`.
 * Contract:
 *  - `[data-testid="settings-backdrop"]` — full-area transparent backdrop;
 *    clicking it calls `setSettingsVisible(false)` (from `@/shared/api`).
 *  - `[data-testid="settings-panel"]` — the real 320px panel; a click inside
 *    it must NOT call `setSettingsVisible` (stopPropagation guards the
 *    backdrop's close handler).
 *
 * Real bug each test catches:
 *  - test A: without a backdrop + close handler, the only way to dismiss the
 *    overlay is the (currently absent) explicit path — clicking outside the
 *    320px panel lands on a different view and silently does nothing.
 *  - test B: a backdrop close handler with no stopPropagation on the panel
 *    would dismiss the overlay every time the user clicks an input/tab inside
 *    it — the settings panel would be unusable.
 *
 * The `queryByTestId` form keeps a missing element an assertion failure, not an
 * unhandled throw.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'

const apiMocks = vi.hoisted(() => ({
  setSettingsVisible: vi.fn(() => Promise.resolve()),
  // `useEffect` subscribes via onSettingsInit and expects an unsubscribe fn.
  onSettingsInit: vi.fn((_cb: (payload: unknown) => void) => () => {}),
  emitProjectSettingsChanged: vi.fn(),
  emitSettingsConfigChanged: vi.fn(),
}))

vi.mock('@/shared/api', () => apiMocks)

// Imported AFTER the mock is registered. Component is a default export.
import Settings from './settings'

beforeEach(() => {
  apiMocks.setSettingsVisible.mockClear()
})

describe('Settings overlay: click-outside-to-close', () => {
  it('A) clicking the backdrop closes the overlay via setSettingsVisible(false)', () => {
    const { queryByTestId } = render(<Settings />)

    const backdrop = queryByTestId('settings-backdrop')
    expect(
      backdrop,
      'the settings overlay must render a full-area [data-testid="settings-backdrop"] — without it there is no click-outside-to-close surface and the overlay can only be dismissed by re-clicking a (stateless, open-only) toolbar button',
    ).not.toBeNull()

    fireEvent.click(backdrop!)

    expect(
      apiMocks.setSettingsVisible,
      'clicking the backdrop must close the overlay',
    ).toHaveBeenCalledTimes(1)
    expect(
      apiMocks.setSettingsVisible,
      'must pass `false` — the main handler branches on the boolean; `true` would (re-)show instead of hide',
    ).toHaveBeenCalledWith(false)
  })

  it('B) clicking inside the panel does NOT close the overlay (stopPropagation)', () => {
    const { queryByTestId } = render(<Settings />)

    const panel = queryByTestId('settings-panel')
    expect(
      panel,
      'the 320px settings panel must carry [data-testid="settings-panel"] so its clicks can be distinguished from backdrop clicks',
    ).not.toBeNull()

    apiMocks.setSettingsVisible.mockClear()
    fireEvent.click(panel!)

    expect(
      apiMocks.setSettingsVisible,
      'a click inside the panel must NOT close the overlay — without stopPropagation the backdrop handler fires on every interaction (input/tab) and the panel becomes unusable',
    ).not.toHaveBeenCalled()
  })
})
