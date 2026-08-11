/** @vitest-environment jsdom */
/**
 * The frame draws the mini-app; the host draws the device around it and hands
 * its own chrome in through two slots. What the slots need from the frame is
 * exactly what the host cannot know: which page is active and how its nav bar
 * is styled.
 *
 * A status bar painted over the mini-app follows the active page's
 * `navigationBarTextStyle` — that is why the slot is a function of the frame's
 * chrome state rather than a fixed node. A host that received a constant would
 * show black glyphs over a dark page, and no assertion about the mini-app
 * itself would notice.
 */
import React from 'react'
import { act, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SIMULATOR_EVENTS as E } from '../shared/bridge-channels.js'
import { MiniAppFrame } from './miniapp-frame.js'
import type { NavigationBarTextStyle } from './navigation-bar.js'
import {
  createFakeHost,
  HOME_PAGE,
  ROOT_BRIDGE_ID,
} from './__test-stubs__/miniapp-frame-harness.js'

/** Renders the frame with a status bar that reports the style it was handed. */
function renderWithSlots(): {
  container: HTMLElement
  setNavTextStyle: (frontColor: string) => void
} {
  const { host, recorder } = createFakeHost(HOME_PAGE)
  const { container } = render(
    <MiniAppFrame
      host={host}
      bridgeId={ROOT_BRIDGE_ID}
      statusBar={({ textStyle }: { textStyle: NavigationBarTextStyle }) => (
        <div data-testid="host-status-bar" data-text-style={textStyle} />
      )}
      deviceOverlay={<div data-testid="host-overlay" />}
    />,
  )
  return {
    container,
    setNavTextStyle(frontColor) {
      act(() => {
        recorder.fire(E.NAV_BAR, {
          bridgeId: ROOT_BRIDGE_ID,
          name: 'setNavigationBarColor',
          params: { frontColor },
        })
      })
    },
  }
}

function statusBarTextStyle(container: HTMLElement): string | null {
  return container
    .querySelector('[data-testid="host-status-bar"]')
    ?.getAttribute('data-text-style') ?? null
}

describe('MiniAppFrame — host chrome slots', () => {
  it('hands the status bar the active page nav text style', () => {
    const { container } = renderWithSlots()

    // The fixture's launch page has no navigationBarTextStyle, so it takes the
    // WeChat default.
    expect(statusBarTextStyle(container)).toBe('black')
  })

  it('re-renders the status bar when the page changes its nav text style', () => {
    const { container, setNavTextStyle } = renderWithSlots()

    setNavTextStyle('#ffffff')

    expect(statusBarTextStyle(container)).toBe('white')
  })

  it('renders the device overlay above the mini-app', () => {
    const { container } = renderWithSlots()

    const overlay = container.querySelector('[data-testid="host-overlay"]')
    expect(overlay).not.toBeNull()
    // The frame renders a fragment into the host's own box, so its children sit
    // directly in the container — and the overlay is last, which is what layers
    // it over the page and the tabBar.
    expect(container.lastElementChild).toBe(overlay)
  })

  it('renders no host chrome when the host supplies none', () => {
    const { host } = createFakeHost(HOME_PAGE)
    const { container } = render(<MiniAppFrame host={host} bridgeId={ROOT_BRIDGE_ID} />)

    expect(container.querySelector('[data-testid="host-status-bar"]')).toBeNull()
    expect(container.querySelector('[data-testid="host-overlay"]')).toBeNull()
    // The mini-app itself still renders — an absent slot is not an absent app.
    expect(container.querySelector('.device-shell__viewport')).not.toBeNull()
  })
})
