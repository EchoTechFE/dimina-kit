/** @vitest-environment jsdom */
/**
 * switchTab replaces the visible stack with the target tab's substack. A page
 * that the replacement leaves in NO stack — neither visible nor cached under
 * any tab — no longer exists as far as the shell is concerned, so its render
 * host must be torn down. Pages that are still held by some tab's substack are
 * the opposite case: they survive the switch (per-tab caching) and destroying
 * them would lose the user's position inside that tab.
 */
import { describe, expect, it } from 'vitest'
import {
  bootShell,
  HOME_PAGE,
  INNER_PAGE,
  OTHER_TAB_PAGE,
  ROOT_BRIDGE_ID,
  serviceNav,
  visiblePagePath,
} from './__test-stubs__/miniapp-frame-harness.js'
import {
  makeDefaultNavigationBarState,
  reduceSwitchTab,
  type PageEntry,
  type ShellState,
} from './index.js'


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

function countClosed(closed: string[], bridgeId: string): number {
  return closed.filter((id) => id === bridgeId).length
}

describe('reduceSwitchTab — the visible page belongs to no tab substack', () => {
  it('unloads and closes the page the switch leaves in no stack', () => {
    const inner = makeEntry(INNER_PAGE, 'inner-bridge', false)
    const home = makeEntry(HOME_PAGE, 'home-bridge', true)
    const state: ShellState = {
      stack: [inner],
      tabStacks: { [HOME_PAGE]: [home] },
      currentTabPath: null,
    }

    const { next, effects } = reduceSwitchTab(state, HOME_PAGE, null)

    expect(next.stack.map((e) => e.bridgeId)).toEqual(['home-bridge'])
    expect(effects).toContainEqual({
      kind: 'lifecycle',
      bridgeId: 'inner-bridge',
      event: 'pageUnload',
    })
    expect(effects).toContainEqual({ kind: 'closePage', bridgeId: 'inner-bridge' })
  })

  it('keeps a page that is still cached under another tab', () => {
    const home = makeEntry(HOME_PAGE, 'home-bridge', true)
    const pushed = makeEntry(INNER_PAGE, 'pushed-bridge', false)
    const other = makeEntry(OTHER_TAB_PAGE, 'other-bridge', true)
    const state: ShellState = {
      stack: [home, pushed],
      tabStacks: { [HOME_PAGE]: [home, pushed] },
      currentTabPath: HOME_PAGE,
    }

    const { effects } = reduceSwitchTab(state, OTHER_TAB_PAGE, other)

    expect(effects.some((e) => e.kind === 'closePage')).toBe(false)
  })
})

describe('MiniAppFrame — a deep-linked non-tab launch page is left behind by switchTab', () => {
  it('closes the launch page once the switch drops it from every stack', async () => {
    const { recorder } = await bootShell(INNER_PAGE)

    await serviceNav(recorder, 'switchTab', HOME_PAGE)

    expect(countClosed(recorder.closedPages, ROOT_BRIDGE_ID)).toBe(1)
    // The service layer hears about a page reaching the screen, leaving it and dying only through these bridge calls, so the delivered sequence is the assertion.
    const tab = recorder.openedEntries.find((page) => page.pagePath === HOME_PAGE)!
    expect(recorder.lifecycles).toEqual([
      { bridgeId: ROOT_BRIDGE_ID, event: 'pageShow' },
      { bridgeId: ROOT_BRIDGE_ID, event: 'pageHide' },
      { bridgeId: ROOT_BRIDGE_ID, event: 'pageUnload' },
      { bridgeId: tab.bridgeId, event: 'pageShow' },
    ])
  })
})

describe('MiniAppFrame — a redirect took a tab root out of the tab caches', () => {
  it('closes the redirected page once the next switchTab drops it', async () => {
    const { recorder } = await bootShell(HOME_PAGE)

    await serviceNav(recorder, 'redirectTo', INNER_PAGE)
    const redirected = recorder.openedEntries.find((p) => p.pagePath === INNER_PAGE)!
    expect(redirected).toBeDefined()

    await serviceNav(recorder, 'switchTab', OTHER_TAB_PAGE)

    expect(countClosed(recorder.closedPages, redirected.bridgeId)).toBe(1)
  })
})

describe('MiniAppFrame — a pushed page still belongs to the tab it was opened from', () => {
  it('survives a switch to another tab and is restored on the way back', async () => {
    const { container, recorder } = await bootShell(HOME_PAGE)

    await serviceNav(recorder, 'navigateTo', INNER_PAGE)
    const pushed = recorder.openedEntries.find((p) => p.pagePath === INNER_PAGE)!
    expect(pushed).toBeDefined()

    await serviceNav(recorder, 'switchTab', OTHER_TAB_PAGE)
    expect(recorder.closedPages).not.toContain(pushed.bridgeId)
    expect(visiblePagePath(container)).toBe(OTHER_TAB_PAGE)

    await serviceNav(recorder, 'switchTab', HOME_PAGE)
    expect(recorder.closedPages).not.toContain(pushed.bridgeId)
    expect(visiblePagePath(container)).toBe(INNER_PAGE)
  })
})
