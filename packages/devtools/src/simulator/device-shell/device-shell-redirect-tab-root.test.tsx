/**
 * `redirectTo` replaces the stack top in place, and when that top is a tab's
 * ROOT the replacement is not a tab page at all. The tab cache must not keep
 * claiming that non-tab page as its root: "back to home" restores the home
 * tab's cached root, so a cache holding the redirect target lands the user back
 * on the page they asked to leave instead of the app's home page.
 *
 * A state whose `tabStacks[tab][0].isTab === false` is self-contradictory —
 * either the cache goes or `currentTabPath` does.
 */
import { act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  makeDefaultNavigationBarState,
  normalizePath,
  reduceRedirectTo,
  type PageEntry,
  type ShellState,
} from '@dimina-kit/electron-runtime/simulator-ui'
import {
  bootShell,
  clearBrowserGlobals,
  FORCED_PAGE,
  homeButton,
  HOME_PAGE,
  INNER_PAGE,
  installBrowserGlobals,
  serviceNav,
  visiblePagePath,
} from './__test-stubs__/device-shell-harness'

function makeEntry(pagePath: string, bridgeId: string, isTab: boolean): PageEntry {
  return {
    bridgeId,
    pagePath,
    query: {},
    isTab,
    windowConfig: {},
    navBar: makeDefaultNavigationBarState({ title: pagePath }),
  }
}

/**
 * Every tab cache must be rooted on its own tab page. A cache keyed by one path
 * but holding another page at [0] is restored later as if it were that tab, so
 * switchTab and "back to home" both land on the wrong page.
 */
function expectTabRootsWellFormed(state: ShellState): void {
  for (const [path, entries] of Object.entries(state.tabStacks)) {
    const root = entries[0]
    expect(root, `tabStacks[${path}] is empty`).toBeDefined()
    expect(root.isTab, `tabStacks[${path}][0] is not a tab page`).toBe(true)
    expect(normalizePath(root.pagePath)).toBe(normalizePath(path))
  }
}

describe('reduceRedirectTo — a tab root is replaced by a non-tab page', () => {
  it('drops the tab cache and leaves no active tab', () => {
    const homeTabEntry = makeEntry(HOME_PAGE, 'home-root', true)
    const state: ShellState = {
      stack: [homeTabEntry],
      tabStacks: { [HOME_PAGE]: [homeTabEntry] },
      currentTabPath: HOME_PAGE,
    }

    const { next } = reduceRedirectTo(state, makeEntry(INNER_PAGE, 'inner-1', false))

    expect(next.tabStacks[HOME_PAGE]).toBeUndefined()
    expect(next.currentTabPath).toBeNull()
    expect(next.stack.map((entry) => entry.bridgeId)).toEqual(['inner-1'])
    expectTabRootsWellFormed(next)
  })

  it('keeps the tab cache tracking the tab when the redirect stays above its root', () => {
    const homeTabEntry = makeEntry(HOME_PAGE, 'home-root', true)
    const pushed = makeEntry(INNER_PAGE, 'inner-1', false)
    const state: ShellState = {
      stack: [homeTabEntry, pushed],
      tabStacks: { [HOME_PAGE]: [homeTabEntry, pushed] },
      currentTabPath: HOME_PAGE,
    }

    const { next } = reduceRedirectTo(state, makeEntry(FORCED_PAGE, 'forced-1', false))

    expect(next.currentTabPath).toBe(HOME_PAGE)
    expect(next.tabStacks[HOME_PAGE]?.map((entry) => entry.bridgeId))
      .toEqual(['home-root', 'forced-1'])
    expectTabRootsWellFormed(next)
  })
})

describe('DeviceShell — the home tab root redirects to an inner page', () => {
  beforeEach(() => {
    installBrowserGlobals()
  })

  afterEach(() => {
    clearBrowserGlobals()
  })

  it('offers the home button on the page that replaced the home tab root', async () => {
    const { container, recorder } = await bootShell(HOME_PAGE)

    await serviceNav(recorder, 'redirectTo', INNER_PAGE)

    expect(homeButton(container)).not.toBeNull()
  })

  it('lands on the app home page when the home button is pressed', async () => {
    const { container, recorder } = await bootShell(HOME_PAGE)
    await serviceNav(recorder, 'redirectTo', INNER_PAGE)

    await act(async () => {
      fireEvent.click(homeButton(container)!)
    })

    await waitFor(() => {
      expect(visiblePagePath(container)).toBe(HOME_PAGE)
    })
  })
})
