/**
 * Contract for the navigation bar's "back to home" button, aligned with
 * WeChat's measured behavior.
 *
 * Visibility (`shouldShowHomeButton`) is the conjunction of two exclusions and
 * one inclusion:
 *   - a tabBar page never shows it,
 *   - the app's own entry page never shows it,
 *     (neither exclusion can be overridden by `homeButton: true`)
 *   - what `homeButton: true` DOES override is the "must be at the bottom of
 *     the page stack" requirement, so a deep inner page can opt in and then
 *     shows the home button ALONGSIDE the back arrow.
 * An unknown entry page (empty string, e.g. a fallback manifest) disables the
 * whole rule — there is no home to go back to.
 *
 * Click behavior (`resolveHomeNavAction`) always terminates with a stack that
 * holds nothing but the home page, so the routing verb is picked from what the
 * home page is and where the current page sits:
 *   - home is a tabBar page  → switchTab
 *   - home is not a tab and the current page is already the stack bottom
 *                            → redirectTo (replace in place)
 *   - otherwise (an opted-in inner page above the bottom) → reLaunch
 *
 * Path comparison is normalization-insensitive throughout: `/pages/a/a` and
 * `pages/a/a` name the same page.
 */
import { describe, expect, it } from 'vitest'
import type { PageWindowConfig, TabBarConfig } from '../shared/bridge-channels.js'
import { navBarFromConfig } from './page-stack-controller.js'
import { resolveHomeNavAction, shouldShowHomeButton } from './navigate-home.js'

const HOME = 'pages/home/home'
const OTHER_TAB = 'pages/mine/mine'
const INNER = 'pages/detail/detail'

interface RuleOverrides {
  pagePath?: string
  homePagePath?: string
  isTab?: boolean
  isStackBottom?: boolean
  forcedByConfig?: boolean
}

/** An inner page sitting at the stack bottom — the baseline "shows" case. */
function rule(overrides: RuleOverrides = {}): boolean {
  return shouldShowHomeButton({
    pagePath: INNER,
    homePagePath: HOME,
    isTab: false,
    isStackBottom: true,
    forcedByConfig: false,
    ...overrides,
  })
}

function tabBar(...pagePaths: string[]): TabBarConfig {
  return { list: pagePaths.map((pagePath) => ({ pagePath })) }
}

// ── Visibility ────────────────────────────────────────────────────────────

describe('shouldShowHomeButton — automatic rule', () => {
  it('shows on a non-tab, non-home page that is the bottom of the stack', () => {
    expect(rule()).toBe(true)
  })

  it('hides on a non-tab, non-home page that is NOT the bottom of the stack', () => {
    expect(rule({ isStackBottom: false })).toBe(false)
  })

  it('hides on a tabBar page even when it is the bottom of the stack', () => {
    expect(rule({ pagePath: OTHER_TAB, isTab: true })).toBe(false)
  })

  it('hides on the app entry page itself', () => {
    expect(rule({ pagePath: HOME, isTab: false })).toBe(false)
  })
})

describe('shouldShowHomeButton — homeButton: true page config', () => {
  it('shows on a non-bottom inner page that opts in, lifting the stack-bottom requirement', () => {
    expect(rule({ isStackBottom: false, forcedByConfig: true })).toBe(true)
  })

  it('still hides on a tabBar page that opts in — the tab exclusion is not overridable', () => {
    expect(rule({
      pagePath: OTHER_TAB,
      isTab: true,
      isStackBottom: false,
      forcedByConfig: true,
    })).toBe(false)
  })

  it('still hides on the entry page that opts in — the home exclusion is not overridable', () => {
    expect(rule({ pagePath: HOME, forcedByConfig: true })).toBe(false)
    expect(rule({ pagePath: HOME, isStackBottom: false, forcedByConfig: true })).toBe(false)
  })
})

describe('shouldShowHomeButton — unknown entry page disables the rule', () => {
  it('hides everywhere when homePagePath is empty, including an opted-in page', () => {
    expect(rule({ homePagePath: '' })).toBe(false)
    expect(rule({ homePagePath: '', isStackBottom: false, forcedByConfig: true })).toBe(false)
  })
})

describe('shouldShowHomeButton — path normalization', () => {
  it('treats a leading-slash current page as the entry page', () => {
    expect(rule({ pagePath: `/${HOME}`, homePagePath: HOME })).toBe(false)
  })

  it('treats a leading-slash entry page as the entry page', () => {
    expect(rule({ pagePath: HOME, homePagePath: `/${HOME}` })).toBe(false)
  })

  it('treats both sides carrying a leading slash as the same page', () => {
    expect(rule({ pagePath: `/${HOME}`, homePagePath: `/${HOME}` })).toBe(false)
  })

  it('does not confuse a different page that merely shares a prefix', () => {
    expect(rule({ pagePath: `${HOME}2`, homePagePath: `/${HOME}` })).toBe(true)
  })
})

// ── Click behavior ────────────────────────────────────────────────────────

describe('resolveHomeNavAction — home page is a tabBar page', () => {
  it('switches tab regardless of how deep the current stack is', () => {
    const tabs = tabBar(HOME, OTHER_TAB)
    expect(resolveHomeNavAction(HOME, tabs, 1)).toEqual({ name: 'switchTab', url: `/${HOME}` })
    expect(resolveHomeNavAction(HOME, tabs, 3)).toEqual({ name: 'switchTab', url: `/${HOME}` })
  })

  it('matches the tabBar entry across leading-slash differences on either side', () => {
    expect(resolveHomeNavAction(`/${HOME}`, tabBar(HOME), 2))
      .toEqual({ name: 'switchTab', url: `/${HOME}` })
    expect(resolveHomeNavAction(HOME, tabBar(`/${HOME}`), 2))
      .toEqual({ name: 'switchTab', url: `/${HOME}` })
  })
})

describe('resolveHomeNavAction — home page is not a tabBar page', () => {
  it('replaces the single page in place when the current page is the stack bottom', () => {
    expect(resolveHomeNavAction(HOME, null, 1)).toEqual({ name: 'redirectTo', url: `/${HOME}` })
    expect(resolveHomeNavAction(HOME, tabBar(OTHER_TAB), 1))
      .toEqual({ name: 'redirectTo', url: `/${HOME}` })
  })

  it('clears the whole stack when the current page sits above the bottom', () => {
    expect(resolveHomeNavAction(HOME, null, 2)).toEqual({ name: 'reLaunch', url: `/${HOME}` })
    expect(resolveHomeNavAction(HOME, tabBar(OTHER_TAB), 5))
      .toEqual({ name: 'reLaunch', url: `/${HOME}` })
  })

  it('treats an empty tabBar list as "home is not a tab"', () => {
    expect(resolveHomeNavAction(HOME, tabBar(), 1)).toEqual({ name: 'redirectTo', url: `/${HOME}` })
  })
})

describe('resolveHomeNavAction — url shape and unknown home', () => {
  it('always emits a single leading slash, whatever the stored home path looks like', () => {
    expect(resolveHomeNavAction(`/${HOME}`, null, 1)?.url).toBe(`/${HOME}`)
    expect(resolveHomeNavAction(`//${HOME}`, null, 1)?.url).toBe(`/${HOME}`)
    expect(resolveHomeNavAction(HOME, tabBar(HOME), 1)?.url).toBe(`/${HOME}`)
  })

  it('issues no navigation at all when the home page is unknown', () => {
    expect(resolveHomeNavAction('', null, 1)).toBeNull()
    expect(resolveHomeNavAction('', tabBar(HOME), 3)).toBeNull()
  })
})

// ── navBarFromConfig home-button override ─────────────────────────────────

describe('navBarFromConfig — homeButtonVisible override', () => {
  const withHomeButton: PageWindowConfig = { homeButton: true }
  const withoutHomeButton: PageWindowConfig = {}

  it('derives visibility from the page config when no override is supplied', () => {
    expect(navBarFromConfig(withHomeButton, 'app').homeButtonVisible).toBe(true)
    expect(navBarFromConfig(withoutHomeButton, 'app').homeButtonVisible).toBe(false)
    expect(navBarFromConfig({ homeButton: false }, 'app').homeButtonVisible).toBe(false)
  })

  it('derives visibility from the page config when the options object omits the key', () => {
    expect(navBarFromConfig(withHomeButton, 'app', {}).homeButtonVisible).toBe(true)
    expect(navBarFromConfig(withoutHomeButton, 'app', {}).homeButtonVisible).toBe(false)
  })

  it('shows the button for a page whose config never asked for it', () => {
    expect(
      navBarFromConfig(withoutHomeButton, 'app', { homeButtonVisible: true }).homeButtonVisible,
    ).toBe(true)
  })

  it('hides the button for a page whose config asked for it', () => {
    expect(
      navBarFromConfig(withHomeButton, 'app', { homeButtonVisible: false }).homeButtonVisible,
    ).toBe(false)
  })

  it('leaves every other derived nav-bar field untouched by the override', () => {
    const config: PageWindowConfig = {
      navigationBarTitleText: 'Detail',
      navigationBarBackgroundColor: '#123456',
      navigationBarTextStyle: 'white',
      navigationStyle: 'custom',
      homeButton: true,
    }
    const overridden = navBarFromConfig(config, 'app', { homeButtonVisible: false })
    expect(overridden.title).toBe('Detail')
    expect(overridden.backgroundColor).toBe('#123456')
    expect(overridden.textStyle).toBe('white')
    expect(overridden.style).toBe('custom')
  })
})
