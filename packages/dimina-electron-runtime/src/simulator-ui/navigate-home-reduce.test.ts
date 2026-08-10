/**
 * `reduceNavigateHomeToTab` — the terminal-state reduction behind "back to
 * home" when the app's home page is a tabBar page.
 *
 * Ordinary `switchTab` preserves each tab's substack, which is right for
 * `wx.switchTab` but wrong here: restoring the home tab's cache would land the
 * user on whatever inner page sits on top of it, back arrow and all. "Back to
 * home" must leave the visible stack holding the home tab's ROOT page, every
 * other tab trimmed to its own root, and every non-tab page destroyed —
 * wherever it lived (the visible stack, the home tab's cache, or another tab's
 * cache).
 *
 * Destruction is accounted for exactly: every discarded page gets both a
 * `pageUnload` lifecycle and a `closePage`, exactly once even when it is
 * reachable through two paths (the visible stack is mirrored into
 * `tabStacks[currentTabPath]`), and no surviving page ever gets either. A page
 * dropped from state without a `closePage` is a leaked render host, so these
 * suites assert the full effect sets rather than membership.
 */
import { describe, expect, it } from 'vitest'
import type { PageWindowConfig } from '../shared/bridge-channels.js'
import { makeDefaultNavigationBarState } from './navigation-bar.js'
import {
  type PageEntry,
  type ShellState,
  type SideEffect,
} from './page-stack-controller.js'
import { reduceNavigateHomeToTab } from './navigate-home.js'

const TAB_A = 'pages/home/home'
const TAB_B = 'pages/mine/mine'
const TAB_C = 'pages/cart/cart'

function makeEntry(pagePath: string, bridgeId: string, isTab = false, windowConfig: PageWindowConfig = {}): PageEntry {
  return {
    bridgeId,
    pagePath,
    query: {},
    isTab,
    windowConfig,
    navBar: makeDefaultNavigationBarState({ title: pagePath }),
  }
}

function lifecycleIds(
  effects: SideEffect[],
  event: 'pageShow' | 'pageHide' | 'pageUnload',
): string[] {
  return effects
    .filter((e) => e.kind === 'lifecycle' && e.event === event)
    .map((e) => e.bridgeId)
    .sort()
}

function closedIds(effects: SideEffect[]): string[] {
  return effects.filter((e) => e.kind === 'closePage').map((e) => e.bridgeId).sort()
}

function stackIds(stack: PageEntry[]): string[] {
  return stack.map((e) => e.bridgeId)
}

function tabStackIds(state: ShellState): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(state.tabStacks).map(([path, entries]) => [path, stackIds(entries)]),
  )
}

// ── Fixtures ──────────────────────────────────────────────────────────────

const tabA = makeEntry(TAB_A, 'a-root', true)
const tabB = makeEntry(TAB_B, 'b-root', true)
const tabC = makeEntry(TAB_C, 'c-root', true)
const pageX = makeEntry('pages/x/x', 'x')
const pageY = makeEntry('pages/y/y', 'y')
const pageP = makeEntry('pages/p/p', 'p', false, { homeButton: true })
const pageD = makeEntry('pages/detail/detail', 'd')

describe('reduceNavigateHomeToTab — home tab already holds a cached substack', () => {
  // Launch on tab A, navigateTo X, switchTab to B, navigateTo the opted-in
  // page P, then press home. Restoring A's cache verbatim would land on X.
  const state: ShellState = {
    stack: [tabB, pageP],
    tabStacks: {
      [TAB_A]: [tabA, pageX],
      [TAB_B]: [tabB, pageP],
      [TAB_C]: [tabC, pageY],
    },
    currentTabPath: TAB_B,
  }

  it('lands on the home tab root rather than the top of its cached substack', () => {
    const { next } = reduceNavigateHomeToTab(state, TAB_A, null)
    expect(stackIds(next.stack)).toEqual(['a-root'])
    expect(next.currentTabPath).toBe(TAB_A)
  })

  it('trims every tab to its own root page', () => {
    const { next } = reduceNavigateHomeToTab(state, TAB_A, null)
    expect(tabStackIds(next)).toEqual({
      [TAB_A]: ['a-root'],
      [TAB_B]: ['b-root'],
      [TAB_C]: ['c-root'],
    })
  })

  it('destroys exactly the discarded pages, counting a doubly-reachable page once', () => {
    const { effects } = reduceNavigateHomeToTab(state, TAB_A, null)
    // P is reachable both from the visible stack and from tabStacks[B].
    expect(lifecycleIds(effects, 'pageUnload')).toEqual(['p', 'x', 'y'])
    expect(closedIds(effects)).toEqual(['p', 'x', 'y'])
  })

  it('leaves every surviving tab root alone', () => {
    const { effects } = reduceNavigateHomeToTab(state, TAB_A, null)
    const destroyed = new Set([...lifecycleIds(effects, 'pageUnload'), ...closedIds(effects)])
    expect(destroyed.has('a-root')).toBe(false)
    expect(destroyed.has('b-root')).toBe(false)
    expect(destroyed.has('c-root')).toBe(false)
  })

  it('shows the restored home root and hides nothing, since the old top is destroyed', () => {
    const { effects } = reduceNavigateHomeToTab(state, TAB_A, null)
    expect(lifecycleIds(effects, 'pageShow')).toEqual(['a-root'])
    expect(lifecycleIds(effects, 'pageHide')).toEqual([])
  })

  it('finds the cached substack when the home path carries a leading slash', () => {
    const { next } = reduceNavigateHomeToTab(state, `/${TAB_A}`, null)
    expect(stackIds(next.stack)).toEqual(['a-root'])
    expect(next.currentTabPath).toBe(TAB_A)
  })
})

describe('reduceNavigateHomeToTab — deep link into a non-tab page, no tab visited yet', () => {
  // The core scenario of the home button: the session launched straight into a
  // non-tab page, so there is no current tab and the visible stack is the only
  // place that page lives.
  const state: ShellState = { stack: [pageD], tabStacks: {}, currentTabPath: null }

  it('replaces the tab-less stack with the freshly opened home tab root', () => {
    const { next } = reduceNavigateHomeToTab(state, TAB_A, tabA)
    expect(stackIds(next.stack)).toEqual(['a-root'])
    expect(next.currentTabPath).toBe(TAB_A)
    expect(tabStackIds(next)).toEqual({ [TAB_A]: ['a-root'] })
  })

  it('unloads and closes the deep-linked page instead of dropping it silently', () => {
    const { effects } = reduceNavigateHomeToTab(state, TAB_A, tabA)
    expect(lifecycleIds(effects, 'pageUnload')).toEqual(['d'])
    expect(closedIds(effects)).toEqual(['d'])
  })

  it('emits no pageShow for a freshly opened root, whose renderer reports its own', () => {
    const { effects } = reduceNavigateHomeToTab(state, TAB_A, tabA)
    expect(lifecycleIds(effects, 'pageShow')).toEqual([])
  })
})

describe('reduceNavigateHomeToTab — home tab never visited, current tab has an inner page', () => {
  const state: ShellState = {
    stack: [tabB, pageP],
    tabStacks: { [TAB_B]: [tabB, pageP] },
    currentTabPath: TAB_B,
  }

  it('registers the freshly opened home tab and trims the previous tab to its root', () => {
    const { next } = reduceNavigateHomeToTab(state, TAB_A, tabA)
    expect(stackIds(next.stack)).toEqual(['a-root'])
    expect(next.currentTabPath).toBe(TAB_A)
    expect(tabStackIds(next)).toEqual({ [TAB_A]: ['a-root'], [TAB_B]: ['b-root'] })
  })

  it('destroys only the inner page, keeping the previous tab root alive', () => {
    const { effects } = reduceNavigateHomeToTab(state, TAB_A, tabA)
    expect(lifecycleIds(effects, 'pageUnload')).toEqual(['p'])
    expect(closedIds(effects)).toEqual(['p'])
  })
})

describe('reduceNavigateHomeToTab — nothing to destroy', () => {
  it('hides the surviving old top and shows the home root without closing anything', () => {
    const state: ShellState = {
      stack: [tabB],
      tabStacks: { [TAB_A]: [tabA], [TAB_B]: [tabB] },
      currentTabPath: TAB_B,
    }
    const { next, effects } = reduceNavigateHomeToTab(state, TAB_A, null)

    expect(stackIds(next.stack)).toEqual(['a-root'])
    expect(tabStackIds(next)).toEqual({ [TAB_A]: ['a-root'], [TAB_B]: ['b-root'] })
    expect(lifecycleIds(effects, 'pageUnload')).toEqual([])
    expect(closedIds(effects)).toEqual([])
    expect(lifecycleIds(effects, 'pageHide')).toEqual(['b-root'])
    expect(lifecycleIds(effects, 'pageShow')).toEqual(['a-root'])
  })

  it('is a no-op on state already parked at the home tab root', () => {
    const state: ShellState = {
      stack: [tabA],
      tabStacks: { [TAB_A]: [tabA] },
      currentTabPath: TAB_A,
    }
    const { next, effects } = reduceNavigateHomeToTab(state, TAB_A, null)

    expect(stackIds(next.stack)).toEqual(['a-root'])
    expect(tabStackIds(next)).toEqual({ [TAB_A]: ['a-root'] })
    expect(lifecycleIds(effects, 'pageUnload')).toEqual([])
    expect(closedIds(effects)).toEqual([])
  })
})

describe('reduceNavigateHomeToTab — caller contract', () => {
  it('throws when the home tab has no cache and the caller opened no page for it', () => {
    const state: ShellState = { stack: [pageD], tabStacks: {}, currentTabPath: null }
    expect(() => reduceNavigateHomeToTab(state, TAB_A, null)).toThrow()
  })
})
