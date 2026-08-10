/**
 * The simulator's "back to home" authority — the nav-bar home button's
 * visibility rule, the routing verb it dispatches, and the terminal-state
 * reduction for the tabBar branch. Mirrors each native platform's
 * `navigateHome` primitive; DeviceShell only dispatches.
 */
import type { TabBarConfig } from '../shared/bridge-channels.js'
import {
  collectAlivePages,
  normalizePath,
  type PageEntry,
  type ReduceResult,
  type ShellState,
  type SideEffect,
} from './page-stack-controller.js'

/**
 * WeChat's back-to-home button visibility rule (calibrated against real
 * WeChat): the nav bar shows it iff the page is neither the app's home page
 * nor a tabBar page — page config `homeButton: true` cannot override those two
 * exclusions — AND the page either sits at the stack bottom (the automatic
 * rule) or sets `homeButton: true`. What the page config DOES lift is the
 * stack-bottom requirement, so an opted-in inner page shows the home button
 * alongside the back arrow. `homePagePath === ''` means the home page is
 * unknown (no compiled manifest) and turns the whole rule off.
 * `navigationStyle: custom` needs no case here: the render layer drops the
 * entire bar. `wx.hideHomeButton()` hides through reduceNavBar.
 */
export function shouldShowHomeButton(opts: {
  pagePath: string
  homePagePath: string
  isTab: boolean
  isStackBottom: boolean
  forcedByConfig: boolean
}): boolean {
  if (opts.isTab || !opts.homePagePath) return false
  if (normalizePath(opts.pagePath) === normalizePath(opts.homePagePath)) return false
  return opts.isStackBottom || opts.forcedByConfig
}

/**
 * The nav action the home button dispatches. Every branch ends on a stack
 * holding nothing but the home page: switchTab when the home page is a tabBar
 * page, redirectTo when the current page is already the stack bottom (in-place
 * swap), and reLaunch above it — an opted-in inner page redirecting would
 * replace only the stack top and leave the pages below alive. Null when the
 * home page is unknown.
 */
export function resolveHomeNavAction(
  homePagePath: string,
  tabBar: TabBarConfig | null,
  stackDepth: number,
): { name: 'switchTab' | 'redirectTo' | 'reLaunch'; url: string } | null {
  if (!homePagePath) return null
  const home = normalizePath(homePagePath)
  const isTab = !!tabBar?.list.some(item => normalizePath(item.pagePath) === home)
  const name = isTab ? 'switchTab' : stackDepth <= 1 ? 'redirectTo' : 'reLaunch'
  return { name, url: `/${home}` }
}

/**
 * Every tab trimmed to its own root page. The visible stack is the current
 * tab's live stack, so its bottom is that tab's authoritative root — the
 * cached substack may lag behind it.
 */
function trimTabsToRoots(state: ShellState): Record<string, PageEntry[]> {
  const roots: Record<string, PageEntry[]> = {}
  for (const [path, entries] of Object.entries(state.tabStacks)) {
    const root = entries[0]
    if (root) roots[path] = [root]
  }
  const liveRoot = state.stack[0]
  if (state.currentTabPath && liveRoot) roots[state.currentTabPath] = [liveRoot]
  return roots
}

/**
 * Terminal-state reduction for "back to home" when the app's home page is a
 * tabBar page. Ordinary switchTab preserves each tab's substack — right for
 * `wx.switchTab`, wrong here: restoring the home tab's cache would land on
 * whatever inner page sits on top of it, back arrow and all. This lands on the
 * home tab's ROOT, trims every other tab to its own root, and destroys every
 * non-tab page wherever it lived (visible stack, home tab's cache, another
 * tab's cache) with a pageUnload + closePage each — a page dropped from state
 * without a closePage is a leaked render host.
 */
export function reduceNavigateHomeToTab(
  state: ShellState,
  homeTabPath: string,
  /** Provided when the home tab has no cached substack yet — the caller has
   *  already opened a fresh page for it. Null when it is cached. */
  freshlyOpenedEntry: PageEntry | null,
): ReduceResult {
  const home = normalizePath(homeTabPath)
  const prevTop = state.stack[state.stack.length - 1]
  const aliveBefore = collectAlivePages(state)
  const tabStacks = trimTabsToRoots(state)

  const cachedRoot = tabStacks[home]?.[0]
  const homeRoot = cachedRoot ?? freshlyOpenedEntry
  if (!homeRoot) {
    throw new Error(
      `[page-stack] navigateHome to tab ${home} requires either a cached substack or a freshly-opened entry`,
    )
  }
  tabStacks[home] = [homeRoot]

  const survivors = new Set(Object.values(tabStacks).map(entries => entries[0]!.bridgeId))
  const effects: SideEffect[] = []
  for (const bridgeId of aliveBefore) {
    if (survivors.has(bridgeId)) continue
    effects.push({ kind: 'lifecycle', bridgeId, event: 'pageUnload' })
    effects.push({ kind: 'closePage', bridgeId })
  }
  if (prevTop && prevTop.bridgeId !== homeRoot.bridgeId && survivors.has(prevTop.bridgeId)) {
    effects.push({ kind: 'lifecycle', bridgeId: prevTop.bridgeId, event: 'pageHide' })
  }
  if (cachedRoot) {
    // Restored from cache — a freshly opened page gets its own lifecycle from
    // the renderer init path.
    effects.push({ kind: 'lifecycle', bridgeId: homeRoot.bridgeId, event: 'pageShow' })
  }

  return {
    next: { ...state, stack: [homeRoot], tabStacks, currentTabPath: home },
    effects,
  }
}
