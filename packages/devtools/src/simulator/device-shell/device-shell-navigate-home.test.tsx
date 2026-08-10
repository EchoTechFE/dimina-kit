/**
 * DeviceShell's "back to home" journeys that only show up on the second
 * transfer — a cached tab substack under the home page, and a second click
 * landing inside the first click's open-page round trip.
 *
 * Both are leak-shaped: a page can vanish from the shell's state while its
 * render host stays alive because nobody asked main to close it. The suites
 * below therefore keep a ledger (every page opened, every page closed, every
 * page still mounted) instead of only checking what is on screen.
 */
import { act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bootShell,
  clearBrowserGlobals,
  FORCED_PAGE,
  homeButton,
  HOME_PAGE,
  INNER_PAGE,
  installBrowserGlobals,
  latestStack,
  mountedPageCount,
  OTHER_TAB_PAGE,
  ROOT_BRIDGE_ID,
  serviceNav,
  visiblePagePath,
  type HostRecorder,
} from './__test-stubs__/device-shell-harness'

beforeEach(() => {
  installBrowserGlobals()
})

afterEach(() => {
  clearBrowserGlobals()
})

describe('DeviceShell — home tab already carries a cached substack', () => {
  /**
   * Launch on the home tab, push an inner page onto it, switch to the other
   * tab, then push the opted-in page that shows the home button. Restoring the
   * home tab's cache verbatim would land on its inner page, back arrow and all.
   */
  async function buildCachedHomeSubstack(): Promise<{
    container: HTMLElement
    recorder: HostRecorder
  }> {
    const { container, recorder } = await bootShell(HOME_PAGE)
    await serviceNav(recorder, 'navigateTo', INNER_PAGE)
    await serviceNav(recorder, 'switchTab', OTHER_TAB_PAGE)
    await serviceNav(recorder, 'navigateTo', FORCED_PAGE)
    return { container, recorder }
  }

  it('offers the home button on the opted-in page reached from another tab', async () => {
    const { container } = await buildCachedHomeSubstack()
    expect(homeButton(container)).not.toBeNull()
  })

  it('lands on the home page itself, not on the inner page cached above it', async () => {
    const { container, recorder } = await buildCachedHomeSubstack()

    await act(async () => {
      fireEvent.click(homeButton(container)!)
    })

    await waitFor(() => {
      expect(latestStack(recorder)).toEqual([HOME_PAGE])
    })
    expect(visiblePagePath(container)).toBe(HOME_PAGE)
  })

  it('leaves no back arrow and no home button once the home page is on screen', async () => {
    const { container } = await buildCachedHomeSubstack()

    await act(async () => {
      fireEvent.click(homeButton(container)!)
    })

    await waitFor(() => {
      expect(visiblePagePath(container)).toBe(HOME_PAGE)
    })
    expect(container.querySelector('.nav-bar__back')).toBeNull()
    expect(homeButton(container)).toBeNull()
  })

  it('closes every page it discarded from the visible stack and the tab caches', async () => {
    const { container, recorder } = await buildCachedHomeSubstack()

    await act(async () => {
      fireEvent.click(homeButton(container)!)
    })

    await waitFor(() => {
      expect(latestStack(recorder)).toEqual([HOME_PAGE])
    })
    // Survivors are the home tab root plus the other tab's root; the inner page
    // cached above home and the opted-in page must both be gone, exactly once.
    const discarded = recorder.openedEntries
      .filter((page) => page.pagePath === INNER_PAGE || page.pagePath === FORCED_PAGE)
      .map((page) => page.bridgeId)
    expect(recorder.closedPages.slice().sort()).toEqual(discarded.slice().sort())
    expect(mountedPageCount(container)).toBe(2)
  })
})

describe('DeviceShell — the home button is clicked twice in the open-page window', () => {
  it('opens the home page once and leaves no page unaccounted for', async () => {
    const { container, recorder } = await bootShell(INNER_PAGE)
    const release = recorder.gateOpenPage()

    await act(async () => {
      fireEvent.click(homeButton(container)!)
      fireEvent.click(homeButton(container)!)
    })
    await act(async () => {
      release()
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(latestStack(recorder)).toEqual([HOME_PAGE])
    })
    // The second click must wait for the first to settle, by which point the
    // home page is already the stack bottom and no second page is opened.
    expect(recorder.openedPages).toEqual([HOME_PAGE])
    // Ledger: every page ever opened is either the one on screen or closed.
    const unaccounted = recorder.openedEntries
      .filter((page) => !recorder.closedPages.includes(page.bridgeId))
      .map((page) => page.pagePath)
    expect(unaccounted).toEqual([HOME_PAGE])
    expect(recorder.closedPages).toEqual([ROOT_BRIDGE_ID])
    expect(mountedPageCount(container)).toBe(1)
  })
})
