import { describe, it, expect } from 'vitest'
import {
  applyColorMutation,
  enumerateMounted,
  makeInitialShellState,
  mutatePageNavBar,
  navBarFromConfig,
  normalizePath,
  parseUrl,
  reduceNavBar,
  reduceNavigateBack,
  reduceNavigateTo,
  reduceReLaunch,
  reduceRedirectTo,
  reduceSwitchTab,
  type PageEntry,
  type ShellState,
} from './page-stack-controller'
import { makeDefaultNavigationBarState, type NavigationBarState } from './navigation-bar'

function makeNavBar(overrides: Partial<NavigationBarState> = {}): NavigationBarState {
  return makeDefaultNavigationBarState({
    title: '',
    backgroundColor: '#000000',
    textStyle: 'white',
    style: 'default',
    homeButtonVisible: false,
    loading: false,
    ...overrides,
  })
}

// ── helpers ───────────────────────────────────────────────────────────────

let nextId = 0
function freshBridgeId(label = 'bid'): string {
  nextId += 1
  return `${label}-${nextId}`
}

interface MakeEntryOpts {
  pagePath: string
  isTab?: boolean
  bridgeId?: string
  title?: string
}

function makeEntry({ pagePath, isTab = false, bridgeId, title }: MakeEntryOpts): PageEntry {
  return {
    bridgeId: bridgeId ?? freshBridgeId(pagePath),
    pagePath,
    query: {},
    isTab,
    windowConfig: {},
    navBar: makeDefaultNavigationBarState({
      title: title ?? pagePath,
      backgroundColor: '#ffffff',
      textStyle: 'black',
      style: 'default',
      homeButtonVisible: false,
    }),
  }
}

function bridgeIds(stack: PageEntry[]): string[] {
  return stack.map((e) => e.bridgeId)
}

// Convenience: build a state where tabA is active with `extraPagesAboveTabA`
// navigateTo'd pages on top.
function buildStateWithTabANavigations(extraPagesAboveTabA: PageEntry[]): {
  state: ShellState
  tabA: PageEntry
  tabB: PageEntry
} {
  const tabA = makeEntry({ pagePath: 'pages/tabA/index', isTab: true })
  const tabB = makeEntry({ pagePath: 'pages/tabB/index', isTab: true })
  // Initial state has only tabA. We register tabB by switching there once
  // and back, but to keep the tests focused we manually seed tabStacks.
  const state: ShellState = {
    stack: [tabA, ...extraPagesAboveTabA],
    tabStacks: {
      [tabA.pagePath]: [tabA, ...extraPagesAboveTabA],
    },
    currentTabPath: tabA.pagePath,
  }
  return { state, tabA, tabB }
}

// ── makeInitialShellState ─────────────────────────────────────────────────

describe('makeInitialShellState', () => {
  it('seeds tabStacks with the initial entry when it is a tab page', () => {
    const entry = makeEntry({ pagePath: 'pages/home/index', isTab: true })
    const state = makeInitialShellState(entry)
    expect(state.stack).toEqual([entry])
    expect(state.currentTabPath).toBe('pages/home/index')
    expect(state.tabStacks).toEqual({ 'pages/home/index': [entry] })
  })

  it('leaves tabStacks empty when the initial entry is not a tab page', () => {
    const entry = makeEntry({ pagePath: 'pages/standalone/index', isTab: false })
    const state = makeInitialShellState(entry)
    expect(state.currentTabPath).toBeNull()
    expect(state.tabStacks).toEqual({})
  })
})

// ── parseUrl ──────────────────────────────────────────────────────────────

describe('parseUrl', () => {
  it('extracts pagePath without leading slash and the query map', () => {
    expect(parseUrl('/pages/p/index?id=42&name=foo')).toEqual({
      pagePath: 'pages/p/index',
      query: { id: '42', name: 'foo' },
    })
  })

  it('returns empty path + empty query for a non-string / empty input', () => {
    expect(parseUrl(null)).toEqual({ pagePath: '', query: {} })
    expect(parseUrl('')).toEqual({ pagePath: '', query: {} })
  })
})

// ── navigateTo ────────────────────────────────────────────────────────────

describe('reduceNavigateTo', () => {
  it('pushes the new entry on top and mirrors it into the current tab substack', () => {
    const { state, tabA } = buildStateWithTabANavigations([])
    const page1 = makeEntry({ pagePath: 'pages/detail/index', isTab: false })
    const { next, effects } = reduceNavigateTo(state, page1)

    expect(bridgeIds(next.stack)).toEqual([tabA.bridgeId, page1.bridgeId])
    expect(bridgeIds(next.tabStacks[tabA.pagePath])).toEqual([tabA.bridgeId, page1.bridgeId])
    expect(effects).toEqual([{ kind: 'lifecycle', bridgeId: tabA.bridgeId, event: 'pageHide' }])
  })
})

// ── switchTab: PER-TAB SUBSTACK PRESERVATION (the heart of this refactor) ─

describe('reduceSwitchTab — per-tab substack', () => {
  it('after navigateTo on tabA, switching to tabB and back restores tabA stack fully (page1, page2 still present)', () => {
    // 1. Start at tabA, navigateTo two pages on top.
    const { state: s0, tabA, tabB } = buildStateWithTabANavigations([])
    const page1 = makeEntry({ pagePath: 'pages/detail/index' })
    const page2 = makeEntry({ pagePath: 'pages/detail2/index' })

    const { next: s1 } = reduceNavigateTo(s0, page1)
    const { next: s2 } = reduceNavigateTo(s1, page2)
    expect(bridgeIds(s2.stack)).toEqual([tabA.bridgeId, page1.bridgeId, page2.bridgeId])
    // tabA's substack must mirror the live stack.
    expect(bridgeIds(s2.tabStacks[tabA.pagePath])).toEqual(
      [tabA.bridgeId, page1.bridgeId, page2.bridgeId],
    )

    // 2. switchTab to tabB (fresh — tabB not in cache).
    const { next: s3 } = reduceSwitchTab(s2, tabB.pagePath, tabB)
    expect(bridgeIds(s3.stack)).toEqual([tabB.bridgeId])
    expect(s3.currentTabPath).toBe(tabB.pagePath)
    // tabA's substack survives, byte-identical.
    expect(bridgeIds(s3.tabStacks[tabA.pagePath])).toEqual(
      [tabA.bridgeId, page1.bridgeId, page2.bridgeId],
    )

    // 3. switchTab back to tabA — should restore page1+page2 on top.
    const { next: s4 } = reduceSwitchTab(s3, tabA.pagePath, null)
    expect(bridgeIds(s4.stack)).toEqual([tabA.bridgeId, page1.bridgeId, page2.bridgeId])
    expect(s4.currentTabPath).toBe(tabA.pagePath)
  })

  it('does not unload / closePage any tab page (or its navigateTo subpages) when switching tabs', () => {
    const { state: s0, tabA, tabB } = buildStateWithTabANavigations([])
    const page1 = makeEntry({ pagePath: 'pages/detail/index' })
    const { next: s1 } = reduceNavigateTo(s0, page1)
    const { next: s2, effects } = reduceSwitchTab(s1, tabB.pagePath, tabB)

    // No closePage effect at all — every previous page survives in tabA's substack.
    expect(effects.find((e) => e.kind === 'closePage')).toBeUndefined()
    // Only a single pageHide for the previously-visible top (page1).
    const hideEffects = effects.filter((e) => e.kind === 'lifecycle' && e.event === 'pageHide')
    expect(hideEffects).toEqual([{ kind: 'lifecycle', bridgeId: page1.bridgeId, event: 'pageHide' }])
    // tabA itself + page1 are still in tabStacks (the source of truth for "mounted").
    const tabAStack = s2.tabStacks[tabA.pagePath]
    expect(bridgeIds(tabAStack)).toEqual([tabA.bridgeId, page1.bridgeId])
  })

  it('switching to the same tab is idempotent (no extra effects, no duplicated substack entries)', () => {
    const { state, tabA } = buildStateWithTabANavigations([])
    const { next, effects } = reduceSwitchTab(state, tabA.pagePath, null)
    expect(next.currentTabPath).toBe(tabA.pagePath)
    expect(bridgeIds(next.stack)).toEqual([tabA.bridgeId])
    // No pageHide because prev top === new top.
    expect(effects.find((e) => e.kind === 'lifecycle' && e.event === 'pageHide')).toBeUndefined()
  })

  it('rejects fresh switchTab when neither cached nor freshlyOpenedEntry is provided', () => {
    const { state, tabB } = buildStateWithTabANavigations([])
    expect(() => reduceSwitchTab(state, tabB.pagePath, null)).toThrow(
      /requires either a cached substack or a freshly-opened entry/,
    )
  })
})

// ── enumerateMounted ──────────────────────────────────────────────────────

describe('enumerateMounted', () => {
  it('includes both tab A subpages and tab B even when tabB is not the active tab', () => {
    const { state: s0, tabA, tabB } = buildStateWithTabANavigations([])
    // navigateTo on tabA: page1 above tabA.
    const page1 = makeEntry({ pagePath: 'pages/detail/index' })
    const { next: s1 } = reduceNavigateTo(s0, page1)
    // switch to tabB (fresh) and navigateTo page2 above tabB.
    const { next: s2 } = reduceSwitchTab(s1, tabB.pagePath, tabB)
    const page2 = makeEntry({ pagePath: 'pages/cart-detail/index' })
    const { next: s3 } = reduceNavigateTo(s2, page2)

    const mounted = enumerateMounted(s3)
    const ids = mounted.map((m) => m.entry.bridgeId)
    // Every alive page across both tabs must mount.
    expect(ids).toContain(tabA.bridgeId)
    expect(ids).toContain(page1.bridgeId)
    expect(ids).toContain(tabB.bridgeId)
    expect(ids).toContain(page2.bridgeId)
    // Only page2 (visible top) is visible.
    const visibleIds = mounted.filter((m) => m.visible).map((m) => m.entry.bridgeId)
    expect(visibleIds).toEqual([page2.bridgeId])
  })
})

// ── reLaunch ──────────────────────────────────────────────────────────────

describe('reduceReLaunch', () => {
  it('clears all tabStacks and emits pageUnload+closePage for every previously-alive page', () => {
    // Build a state with tabA + page1 navigated, tabB cached separately.
    const tabA = makeEntry({ pagePath: 'pages/tabA/index', isTab: true })
    const tabB = makeEntry({ pagePath: 'pages/tabB/index', isTab: true })
    const page1 = makeEntry({ pagePath: 'pages/detail/index' })
    const state: ShellState = {
      stack: [tabA, page1],
      tabStacks: {
        [tabA.pagePath]: [tabA, page1],
        [tabB.pagePath]: [tabB],
      },
      currentTabPath: tabA.pagePath,
    }

    const fresh = makeEntry({ pagePath: 'pages/launched/index' })
    const { next, effects } = reduceReLaunch(state, fresh)
    expect(next.stack).toEqual([fresh])
    expect(next.tabStacks).toEqual({}) // fresh is not a tab page
    expect(next.currentTabPath).toBeNull()

    const closed = effects.filter((e) => e.kind === 'closePage').map((e) => (e as { bridgeId: string }).bridgeId).sort()
    expect(closed).toEqual([tabA.bridgeId, tabB.bridgeId, page1.bridgeId].sort())
    const unloaded = effects.filter((e) => e.kind === 'lifecycle' && e.event === 'pageUnload')
      .map((e) => (e as { bridgeId: string }).bridgeId).sort()
    expect(unloaded).toEqual([tabA.bridgeId, tabB.bridgeId, page1.bridgeId].sort())
  })

  it('preserves the fresh entry when reLaunching to a tab page (rebuilds tabStacks from scratch)', () => {
    const tabA = makeEntry({ pagePath: 'pages/tabA/index', isTab: true })
    const state: ShellState = {
      stack: [tabA],
      tabStacks: { [tabA.pagePath]: [tabA] },
      currentTabPath: tabA.pagePath,
    }
    const tabBLaunched = makeEntry({ pagePath: 'pages/tabB/index', isTab: true })
    const { next } = reduceReLaunch(state, tabBLaunched)
    expect(next.tabStacks).toEqual({ [tabBLaunched.pagePath]: [tabBLaunched] })
    expect(next.currentTabPath).toBe(tabBLaunched.pagePath)
  })
})

// ── navigateBack ──────────────────────────────────────────────────────────

describe('reduceNavigateBack', () => {
  it('pops from current stack + active-tab substack, unloads popped pages', () => {
    const { state: s0, tabA } = buildStateWithTabANavigations([])
    const page1 = makeEntry({ pagePath: 'pages/p1/index' })
    const page2 = makeEntry({ pagePath: 'pages/p2/index' })
    const { next: s1 } = reduceNavigateTo(s0, page1)
    const { next: s2 } = reduceNavigateTo(s1, page2)

    const result = reduceNavigateBack(s2, 1)
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(bridgeIds(result.next.stack)).toEqual([tabA.bridgeId, page1.bridgeId])
    expect(bridgeIds(result.next.tabStacks[tabA.pagePath])).toEqual([tabA.bridgeId, page1.bridgeId])
    const closed = result.effects.filter((e) => e.kind === 'closePage').map((e) => (e as { bridgeId: string }).bridgeId)
    expect(closed).toEqual([page2.bridgeId])
  })

  it('refuses to back when only the root tab page remains', () => {
    const { state } = buildStateWithTabANavigations([])
    const result = reduceNavigateBack(state, 1)
    expect(result).toEqual({ error: 'no page to back' })
  })
})

// ── redirectTo ────────────────────────────────────────────────────────────

describe('reduceRedirectTo', () => {
  it('replaces the visible top + updates tabStacks for the active tab', () => {
    const { state: s0, tabA } = buildStateWithTabANavigations([])
    const page1 = makeEntry({ pagePath: 'pages/p1/index' })
    const { next: s1 } = reduceNavigateTo(s0, page1)

    const page2 = makeEntry({ pagePath: 'pages/p2/index' })
    const { next: s2, effects } = reduceRedirectTo(s1, page2)
    expect(bridgeIds(s2.stack)).toEqual([tabA.bridgeId, page2.bridgeId])
    expect(bridgeIds(s2.tabStacks[tabA.pagePath])).toEqual([tabA.bridgeId, page2.bridgeId])
    const closed = effects.filter((e) => e.kind === 'closePage').map((e) => (e as { bridgeId: string }).bridgeId)
    expect(closed).toEqual([page1.bridgeId])
  })
})

// ── parseUrl (extra edge cases beyond the basic happy-path above) ────────

describe('parseUrl — edge cases', () => {
  it("preserves additional '=' inside a value (only the first '=' separates key from value)", () => {
    expect(parseUrl('p?token=a=b=c')).toEqual({ pagePath: 'p', query: { token: 'a=b=c' } })
  })

  it('decodes percent-encoded key and value via decodeURIComponent', () => {
    expect(parseUrl('p?%E4%B8%AD%E6%96%87=%E4%BD%A0%E5%A5%BD')).toEqual({
      pagePath: 'p',
      query: { 中文: '你好' },
    })
  })

  it('returns an empty query map when the url has no `?`', () => {
    expect(parseUrl('/pages/just/path')).toEqual({ pagePath: 'pages/just/path', query: {} })
  })
})

// ── normalizePath ────────────────────────────────────────────────────────

describe('normalizePath', () => {
  it('strips a single leading slash', () => {
    expect(normalizePath('/pages/home')).toBe('pages/home')
  })

  it('returns empty string for empty input without throwing', () => {
    expect(normalizePath('')).toBe('')
  })

  it('strips multiple leading slashes and keeps multi-segment path intact', () => {
    expect(normalizePath('///a/b/c/d')).toBe('a/b/c/d')
  })
})

// ── navBarFromConfig ─────────────────────────────────────────────────────

describe('navBarFromConfig', () => {
  it('falls back to defaults (#ffffff bg, black text, default style) and uses fallback title when config is empty', () => {
    const state = navBarFromConfig({}, 'my-app-id')
    expect(state).toMatchObject({
      title: 'my-app-id',
      backgroundColor: '#ffffff',
      textStyle: 'black',
      style: 'default',
      homeButtonVisible: false,
    })
  })

  it('uses navigationBarTitleText when supplied (overriding the fallback)', () => {
    expect(navBarFromConfig({ navigationBarTitleText: 'Hello' }, 'fallback').title).toBe('Hello')
  })

  it('respects navigationBarTextStyle: white', () => {
    expect(navBarFromConfig({ navigationBarTextStyle: 'white' }, 'x').textStyle).toBe('white')
  })

  it('respects a custom navigationBarBackgroundColor', () => {
    expect(navBarFromConfig({ navigationBarBackgroundColor: '#abcdef' }, 'x').backgroundColor).toBe('#abcdef')
  })

  it("respects navigationStyle: 'custom'", () => {
    expect(navBarFromConfig({ navigationStyle: 'custom' }, 'x').style).toBe('custom')
  })

  it('shows the home button only when config.homeButton === true (strict equality)', () => {
    expect(navBarFromConfig({ homeButton: true }, 'x').homeButtonVisible).toBe(true)
    // Defensive: non-true truthy values are rejected.
    expect(navBarFromConfig({ homeButton: 1 as unknown as boolean }, 'x').homeButtonVisible).toBe(false)
  })
})

// ── reduceNavBar ─────────────────────────────────────────────────────────

describe('reduceNavBar', () => {
  it('setNavigationBarTitle updates the title field', () => {
    const next = reduceNavBar(makeNavBar({ title: 'old' }), 'setNavigationBarTitle', { title: 'new' })
    expect(next.title).toBe('new')
  })

  it('setNavigationBarColor delegates to applyColorMutation (frontColor white → textStyle white)', () => {
    const next = reduceNavBar(makeNavBar({ textStyle: 'black' }), 'setNavigationBarColor', { frontColor: '#ffffff' })
    expect(next.textStyle).toBe('white')
  })

  it('showNavigationBarLoading flips loading=true', () => {
    expect(reduceNavBar(makeNavBar({ loading: false }), 'showNavigationBarLoading', {}).loading).toBe(true)
  })

  it('hideNavigationBarLoading flips loading=false', () => {
    expect(reduceNavBar(makeNavBar({ loading: true }), 'hideNavigationBarLoading', {}).loading).toBe(false)
  })

  it('hideHomeButton flips homeButtonVisible=false', () => {
    expect(reduceNavBar(makeNavBar({ homeButtonVisible: true }), 'hideHomeButton', {}).homeButtonVisible).toBe(false)
  })

  it('returns the same state reference for unknown API names (no mutation, no throw)', () => {
    const prev = makeNavBar({ title: 'unchanged' })
    const next = reduceNavBar(prev, 'wxBananaApi', {})
    expect(next).toBe(prev)
  })
})

// ── applyColorMutation ────────────────────────────────────────────────────

describe('applyColorMutation', () => {
  it('frontColor #ffffff (any case) sets textStyle=white', () => {
    expect(applyColorMutation(makeNavBar({ textStyle: 'black' }), { frontColor: '#FFFFFF' }).textStyle).toBe('white')
  })

  it('frontColor #000000 sets textStyle=black', () => {
    expect(applyColorMutation(makeNavBar({ textStyle: 'white' }), { frontColor: '#000000' }).textStyle).toBe('black')
  })

  it('illegal frontColor (e.g. #ff0000) keeps the previous textStyle', () => {
    const prev = makeNavBar({ textStyle: 'white' })
    expect(applyColorMutation(prev, { frontColor: '#ff0000' }).textStyle).toBe('white')
  })

  it('passes through backgroundColor when supplied as a string', () => {
    expect(applyColorMutation(makeNavBar(), { backgroundColor: '#123456' }).backgroundColor).toBe('#123456')
  })

  it('animation: whitelisted timingFunc (easeIn) is preserved with duration in ms', () => {
    const next = applyColorMutation(makeNavBar(), {
      animation: { duration: 250, timingFunc: 'easeIn' },
    })
    expect(next.colorAnimation).toEqual({ durationMs: 250, timingFunc: 'easeIn' })
  })

  it("animation: non-whitelisted timingFunc (e.g. 'bounce') falls back to 'linear'", () => {
    const next = applyColorMutation(makeNavBar(), {
      animation: { duration: 100, timingFunc: 'bounce' },
    })
    expect(next.colorAnimation?.timingFunc).toBe('linear')
  })

  it('animation: NaN duration clamps to 0 (defensive)', () => {
    const next = applyColorMutation(makeNavBar(), {
      animation: { duration: Number.NaN, timingFunc: 'linear' },
    })
    expect(next.colorAnimation?.durationMs).toBe(0)
  })

  it('returns undefined colorAnimation when no animation field is supplied', () => {
    expect(applyColorMutation(makeNavBar(), {}).colorAnimation).toBeUndefined()
  })
})

// ── mutatePageNavBar ─────────────────────────────────────────────────────

describe('mutatePageNavBar', () => {
  it('applies the mutator only to the matching entry in the visible stack', () => {
    const a = makeEntry({ pagePath: 'pages/a', bridgeId: 'A', title: 'a' })
    const b = makeEntry({ pagePath: 'pages/b', bridgeId: 'B', title: 'b' })
    const state: ShellState = { stack: [a, b], tabStacks: {}, currentTabPath: null }
    const next = mutatePageNavBar(state, 'B', nb => ({ ...nb, title: 'B-new' }))
    expect(next.stack[0].navBar.title).toBe('a')
    expect(next.stack[1].navBar.title).toBe('B-new')
  })

  it('also applies the mutator to matching entries inside tabStacks', () => {
    const home = makeEntry({ pagePath: 'pages/home', bridgeId: 'home-x', isTab: true })
    const state: ShellState = {
      stack: [home],
      tabStacks: { 'pages/home': [home] },
      currentTabPath: 'pages/home',
    }
    const next = mutatePageNavBar(state, 'home-x', nb => ({ ...nb, loading: true }))
    expect(next.tabStacks['pages/home'][0].navBar.loading).toBe(true)
  })
})
