/**
 * A page that becomes the new stack top must get its own `pageShow`, whether
 * it is restored from a tab cache or freshly opened. `page-stack-controller.
 * test.ts` already covers the "restored from cache" branches (navigateBack,
 * switchTab-from-cache); this file covers the branches that currently emit
 * NO pageShow for a freshly opened page — navigateTo, redirectTo, reLaunch,
 * switchTab with a freshly-opened entry — plus the shell's own launch, which
 * has no reducer call at all to hang an effect off.
 *
 * service's runtime.js only calls pageShow from this shell's lifecycle
 * effects (see DESIGN.md's root-cause section) — a page nobody sends
 * pageShow for never fires onShow/onReady, no matter how it entered the
 * stack.
 */
import { describe, expect, it } from 'vitest'
import {
  makeInitialShellState,
  reduceNavigateTo,
  reduceReLaunch,
  reduceRedirectTo,
  reduceSwitchTab,
  revealTopEffects,
  type PageEntry,
  type ShellState,
} from './page-stack-controller.js'
import { makeDefaultNavigationBarState } from './navigation-bar.js'

let nextId = 0
function freshBridgeId(label = 'bid'): string {
  nextId += 1
  return `${label}-${nextId}`
}

function makeEntry(pagePath: string, isTab = false): PageEntry {
  return {
    bridgeId: freshBridgeId(pagePath),
    pagePath,
    query: {},
    isTab,
    windowConfig: {},
    navBar: makeDefaultNavigationBarState({ title: pagePath }),
  }
}

describe('revealTopEffects', () => {
  it('emits pageShow for a single-entry stack, matching the launch pageShow every other transition gets', () => {
    const initial = makeEntry('pages/home/home', true)
    const state = makeInitialShellState(initial)

    expect(revealTopEffects(state)).toEqual([
      { kind: 'lifecycle', bridgeId: initial.bridgeId, event: 'pageShow' },
    ])
  })

  it('reveals whichever page is on top of a multi-entry stack, not the stack bottom', () => {
    const tabA = makeEntry('pages/tabA/index', true)
    const state = makeInitialShellState(tabA)
    const page1 = makeEntry('pages/detail/index')
    const { next } = reduceNavigateTo(state, page1)

    expect(revealTopEffects(next)).toEqual([
      { kind: 'lifecycle', bridgeId: page1.bridgeId, event: 'pageShow' },
    ])
  })
})

describe('reduceNavigateTo — new top gets pageShow', () => {
  it('orders pageHide(prev) before pageShow(new)', () => {
    const tabA = makeEntry('pages/tabA/index', true)
    const state = makeInitialShellState(tabA)
    const page1 = makeEntry('pages/detail/index')

    const { effects } = reduceNavigateTo(state, page1)

    expect(effects).toEqual([
      { kind: 'lifecycle', bridgeId: tabA.bridgeId, event: 'pageHide' },
      { kind: 'lifecycle', bridgeId: page1.bridgeId, event: 'pageShow' },
    ])
  })

  it('still emits pageShow(new) when there is no previous top to hide', () => {
    const state: ShellState = { stack: [], tabStacks: {}, currentTabPath: null }
    const page1 = makeEntry('pages/detail/index')

    const { effects } = reduceNavigateTo(state, page1)

    expect(effects).toEqual([{ kind: 'lifecycle', bridgeId: page1.bridgeId, event: 'pageShow' }])
  })
})

describe('reduceRedirectTo — new top gets pageShow', () => {
  it('orders pageUnload+closePage(prev) before pageShow(new)', () => {
    const tabA = makeEntry('pages/tabA/index', true)
    const state = makeInitialShellState(tabA)
    const page1 = makeEntry('pages/detail/index')
    const { next: s1 } = reduceNavigateTo(state, page1)

    const page2 = makeEntry('pages/detail2/index')
    const { effects } = reduceRedirectTo(s1, page2)

    expect(effects).toEqual([
      { kind: 'lifecycle', bridgeId: page1.bridgeId, event: 'pageUnload' },
      { kind: 'closePage', bridgeId: page1.bridgeId },
      { kind: 'lifecycle', bridgeId: page2.bridgeId, event: 'pageShow' },
    ])
  })
})

describe('reduceReLaunch — new top gets pageShow', () => {
  it('orders every torn-down page before pageShow(new), which arrives last', () => {
    const tabA = makeEntry('pages/tabA/index', true)
    const page1 = makeEntry('pages/detail/index')
    const state: ShellState = {
      stack: [tabA, page1],
      tabStacks: { [tabA.pagePath]: [tabA, page1] },
      currentTabPath: tabA.pagePath,
    }
    const fresh = makeEntry('pages/launched/index')

    const { effects } = reduceReLaunch(state, fresh)

    expect(effects[effects.length - 1]).toEqual({
      kind: 'lifecycle',
      bridgeId: fresh.bridgeId,
      event: 'pageShow',
    })
    // Every torn-down page's unload/close precedes the new page's pageShow.
    const showIndex = effects.findIndex(
      (e) => e.kind === 'lifecycle' && e.event === 'pageShow' && e.bridgeId === fresh.bridgeId,
    )
    expect(effects.slice(0, showIndex).every((e) => e.kind === 'closePage' || e.event !== 'pageShow')).toBe(true)
  })
})

describe('reduceSwitchTab — a freshly-opened target tab also gets pageShow', () => {
  it('emits pageShow(newTop) even though the target tab has no cached substack', () => {
    const tabA = makeEntry('pages/tabA/index', true)
    const state = makeInitialShellState(tabA)
    const tabB = makeEntry('pages/tabB/index', true)

    const { effects } = reduceSwitchTab(state, tabB.pagePath, tabB)

    expect(effects).toEqual([
      { kind: 'lifecycle', bridgeId: tabA.bridgeId, event: 'pageHide' },
      { kind: 'lifecycle', bridgeId: tabB.bridgeId, event: 'pageShow' },
    ])
  })
})
