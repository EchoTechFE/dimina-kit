/**
 * AppDataPanel — no refresh button.
 *
 * The panel is now realtime-pushed (main pushes `SimulatorAppDataChannel.Event`
 * on every service→render setData) and ready-seeded (`useNativeChannelSnapshot`'s
 * `enabled: ready` effect), so the panel's own "↻ 刷新" button is redundant and
 * must be removed. The panel no longer takes an `onRefresh` prop at all — seeding
 * is driven at the tab level (`DockDebugTab`), not by the panel — so this test
 * pins that the panel itself renders no user-facing refresh control.
 */
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { AppDataPanel, type AppDataPanelState as AppDataState } from './appdata-panel-view.js'

function makeState(overrides: Partial<AppDataState> = {}): AppDataState {
  return {
    bridges: [{ id: 'b1', pagePath: 'pages/index/index' }],
    activeBridgeId: 'b1',
    entries: { b1: { 'pages/index/index': { count: 1 } } },
    ...overrides,
  }
}

describe('AppDataPanel: no refresh button', () => {
  it('does not render a button whose text contains "刷新"', () => {
    const { container } = render(
      <AppDataPanel state={makeState()} onSelectBridge={vi.fn()} />,
    )

    const refreshButtons = Array.from(container.querySelectorAll('button')).filter((b) =>
      (b.textContent ?? '').includes('刷新'),
    )
    expect(refreshButtons).toHaveLength(0)
  })

  it('does not render a refresh button even with no bridges (empty state)', () => {
    const { container } = render(
      <AppDataPanel
        state={makeState({ bridges: [], activeBridgeId: null, entries: {} })}
        onSelectBridge={vi.fn()}
      />,
    )

    const refreshButtons = Array.from(container.querySelectorAll('button')).filter((b) =>
      (b.textContent ?? '').includes('刷新'),
    )
    expect(refreshButtons).toHaveLength(0)
  })
})
