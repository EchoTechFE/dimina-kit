/**
 * Rendering and wiring contract for the navigation bar's "back to home"
 * button.
 *
 * Rendering: the home button follows `state.homeButtonVisible` alone. A back
 * arrow does NOT suppress it — a `homeButton: true` inner page shows both, the
 * same way WeChat does. `navigationStyle: 'custom'` removes the whole bar, so
 * neither control renders. The glyph is the filled Material `home` path, the
 * same icon family the back arrow already comes from.
 *
 * Wiring: DeviceShell decides visibility from the live page (tab membership,
 * entry-page identity, stack position) rather than from the page config alone,
 * and a click routes to the app's entry page with the verb that leaves the
 * stack holding nothing but that page.
 */
import React from 'react'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SIMULATOR_EVENTS as E } from '../../shared/bridge-channels'
import {
  bootShell,
  clearBrowserGlobals,
  homeButton,
  HOME_PAGE,
  INNER_PAGE,
  installBrowserGlobals,
  latestStack,
  mountedPageCount,
  OTHER_TAB_PAGE,
  ROOT_BRIDGE_ID,
} from './__test-stubs__/device-shell-harness'
import {
  makeDefaultNavigationBarState,
  NavigationBar,
  type NavigationBarState,
} from './navigation-bar'

/** Material Icons `home` (filled) — google/material-design-icons 24px glyph. */
const HOME_ICON_PATH = 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z'

// ── NavigationBar rendering ───────────────────────────────────────────────

function renderNavBar(
  state: Partial<NavigationBarState>,
  stackDepth: number,
  onHome?: () => void,
) {
  return render(
    <NavigationBar
      state={makeDefaultNavigationBarState(state)}
      stackDepth={stackDepth}
      platform="ios"
      statusBarHeight={44}
      navBarHeight={44}
      onHome={onHome}
    />,
  )
}

describe('NavigationBar — home button coexists with the back arrow', () => {
  it('renders both controls when the page opted in and sits above the stack bottom', () => {
    const { container } = renderNavBar({ homeButtonVisible: true }, 2)
    expect(container.querySelector('.nav-bar__back')).not.toBeNull()
    expect(container.querySelector('.nav-bar__home')).not.toBeNull()
  })

  it('renders the home button alone on a single-page stack', () => {
    const { container } = renderNavBar({ homeButtonVisible: true }, 1)
    expect(container.querySelector('.nav-bar__back')).toBeNull()
    expect(container.querySelector('.nav-bar__home')).not.toBeNull()
  })

  it('renders no home button when visibility is off, whatever the stack depth', () => {
    const shallow = renderNavBar({ homeButtonVisible: false }, 1)
    expect(shallow.container.querySelector('.nav-bar__home')).toBeNull()
    const deep = renderNavBar({ homeButtonVisible: false }, 2)
    expect(deep.container.querySelector('.nav-bar__home')).toBeNull()
    expect(deep.container.querySelector('.nav-bar__back')).not.toBeNull()
  })

  it('renders neither control under navigationStyle custom', () => {
    const { container } = renderNavBar({ homeButtonVisible: true, style: 'custom' }, 2)
    expect(container.querySelector('.nav-bar__home')).toBeNull()
    expect(container.querySelector('.nav-bar__back')).toBeNull()
  })

  it('exposes the home button as an accessible Home control', () => {
    const { container } = renderNavBar({ homeButtonVisible: true }, 1)
    expect(container.querySelector('.nav-bar__home')?.getAttribute('aria-label')).toBe('Home')
  })

  it('calls onHome when the home button is clicked', () => {
    const calls: number[] = []
    const { container } = renderNavBar({ homeButtonVisible: true }, 2, () => { calls.push(1) })
    fireEvent.click(container.querySelector('.nav-bar__home')!)
    expect(calls).toHaveLength(1)
  })

  it('draws the filled Material home glyph rather than a stroked outline', () => {
    const { container } = renderNavBar({ homeButtonVisible: true }, 1)
    const path = container.querySelector('.nav-bar__home svg path')
    expect(path?.getAttribute('d')).toBe(HOME_ICON_PATH)
    expect(path?.getAttribute('fill')).toBe('currentColor')
    expect(path?.getAttribute('stroke')).toBeNull()
  })
})

// ── DeviceShell integration ───────────────────────────────────────────────

beforeEach(() => {
  installBrowserGlobals()
})

afterEach(() => {
  clearBrowserGlobals()
})

describe('DeviceShell — where the home button appears', () => {
  it('shows it when the session starts on a non-tab page that is not the entry page', async () => {
    const { container } = await bootShell(INNER_PAGE)
    expect(homeButton(container)).not.toBeNull()
  })

  it('hides it when the session starts on the entry page', async () => {
    const { container } = await bootShell(HOME_PAGE)
    expect(homeButton(container)).toBeNull()
  })

  it('hides it when the session starts on a non-entry tabBar page', async () => {
    const { container } = await bootShell(OTHER_TAB_PAGE)
    expect(homeButton(container)).toBeNull()
  })
})

describe('DeviceShell — wx.hideHomeButton', () => {
  it('removes the button from the calling page and keeps it removed across re-renders', async () => {
    const { container, recorder, bridgeId } = await bootShell(INNER_PAGE)
    expect(homeButton(container)).not.toBeNull()

    await act(async () => {
      recorder.fire(E.NAV_BAR, { bridgeId, name: 'hideHomeButton', params: {} })
    })
    expect(homeButton(container)).toBeNull()

    // A later nav-bar update re-renders the same page: a visibility recomputed
    // purely from the page's position/identity would resurrect the button the
    // page just asked to hide.
    await act(async () => {
      recorder.fire(E.NAV_BAR, {
        bridgeId,
        name: 'setNavigationBarTitle',
        params: { title: 'Renamed' },
      })
    })
    expect(homeButton(container)).toBeNull()
  })
})

describe('DeviceShell — clicking the home button', () => {
  it('switches to the entry page when that page is a tabBar page', async () => {
    const { container, recorder } = await bootShell(INNER_PAGE)

    await act(async () => {
      fireEvent.click(homeButton(container)!)
    })

    await waitFor(() => {
      expect(recorder.navCallbacks.map((c) => c.errMsg)).toContain('switchTab:ok')
    })
    // reLaunch/redirectTo would have produced their own ack verb instead.
    expect(recorder.navCallbacks.map((c) => c.errMsg))
      .not.toContain('reLaunch:ok')
    expect(recorder.navCallbacks.map((c) => c.errMsg))
      .not.toContain('redirectTo:ok')
    expect(recorder.openedPages).toContain(HOME_PAGE)
  })

  it('leaves a page stack holding nothing but the entry page', async () => {
    const { container, recorder } = await bootShell(INNER_PAGE)

    await act(async () => {
      fireEvent.click(homeButton(container)!)
    })

    await waitFor(() => {
      expect(latestStack(recorder)).toEqual([HOME_PAGE])
    })
  })

  it('drops the home button once the entry page is on screen', async () => {
    const { container } = await bootShell(INNER_PAGE)

    await act(async () => {
      fireEvent.click(homeButton(container)!)
    })

    await waitFor(() => {
      expect(homeButton(container)).toBeNull()
    })
  })

  it('tears down the deep-linked page it left behind instead of leaking it', async () => {
    const { container, recorder } = await bootShell(INNER_PAGE)

    await act(async () => {
      fireEvent.click(homeButton(container)!)
    })

    await waitFor(() => {
      expect(latestStack(recorder)).toEqual([HOME_PAGE])
    })
    // The deep-linked page is the session root main opened for the spawn.
    expect(recorder.closedPages).toEqual([ROOT_BRIDGE_ID])
    expect(mountedPageCount(container)).toBe(1)
  })
})
