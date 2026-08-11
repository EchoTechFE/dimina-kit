/**
 * Routing operations for MiniAppFrame (navigateTo / navigateBack / redirectTo /
 * reLaunch / switchTab): each opens pages through the MiniAppHost, feeds the
 * pure reducers in page-stack-controller, commits the new ShellState via the
 * frame's setState and applies the returned side effects. Kept out of
 * miniapp-frame.tsx so that file stays presentational glue.
 *
 * Every operation that mints a PageEntry also decides that page's home-button
 * visibility here, because the verdict depends on where the new page lands in
 * the stack — knowledge the reducers and the page config alone do not have.
 */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { NavActionPayload } from '../shared/bridge-channels.js'
import type { MiniAppHost } from './miniapp-host.js'
import {
  navBarFromConfig,
  normalizePath,
  parseUrl,
  reduceNavigateBack,
  reduceNavigateTo,
  reduceReLaunch,
  reduceRedirectTo,
  reduceSwitchTab,
  type PageEntry,
  type ShellState,
  type SideEffect,
} from './page-stack-controller.js'
import {
  reduceNavigateHomeToTab,
  resolveHomeNavAction,
  shouldShowHomeButton,
} from './navigate-home.js'
import type { TabBarState } from './tab-bar-state.js'

export interface MiniAppFrameState {
  shell: ShellState
  tabBar: TabBarState
}

/**
 * A nav action the shell can perform. `navigateHome` is the shell's own
 * primitive behind the nav-bar home button (mirroring each native platform's
 * `navigateHome`); the rest arrive from the service layer over NAV_ACTION.
 */
export type ShellNavPayload =
  | NavActionPayload
  | (Omit<NavActionPayload, 'name'> & { name: 'navigateHome' })

export type StateRef = MutableRefObject<MiniAppFrameState>
export type SetState = Dispatch<SetStateAction<MiniAppFrameState>>
export type Ack = (ok: boolean, errMsg: string) => void
export type ApplySideEffects = (effects: SideEffect[]) => void

/**
 * The single commit point for shell state. `stateRef` is the snapshot every
 * routing operation reduces from, so it must carry an action's result the
 * instant that action finishes — not one React commit later. The nav queue
 * hands the next action a microtask while React commits on a scheduler task,
 * so a ref refreshed only by a passive effect still holds the pre-action stack
 * when the next action reads it: two navigateBacks in one tick would then both
 * reduce from the same three-page stack, pop the same page twice and close its
 * render host twice. Writing the ref here keeps it in step with the fact.
 */
export function commitShell(ref: StateRef, setState: SetState, next: ShellState): void {
  ref.current = { ...ref.current, shell: next }
  setState(prev => ({ ...prev, shell: next }))
}

/** The tabBar half of the same contract — see `commitShell`. */
export function commitTabBar(ref: StateRef, setState: SetState, next: TabBarState): void {
  ref.current = { ...ref.current, tabBar: next }
  setState(prev => ({ ...prev, tabBar: next }))
}

/**
 * Build the PageEntry for a page the host just opened, with its home button
 * resolved against the app's home page and the stack position the caller knows
 * this page is landing at.
 */
function makePageEntry(
  host: MiniAppHost,
  opened: { bridgeId: string; pagePath: string; isTab: boolean; windowConfig: PageEntry['windowConfig'] },
  query: Record<string, unknown>,
  isStackBottom: boolean,
): PageEntry {
  return {
    bridgeId: opened.bridgeId,
    pagePath: opened.pagePath,
    query,
    isTab: opened.isTab,
    windowConfig: opened.windowConfig,
    navBar: navBarFromConfig(opened.windowConfig, host.appId, {
      homeButtonVisible: shouldShowHomeButton({
        pagePath: opened.pagePath,
        homePagePath: host.getHomePagePath(),
        isTab: opened.isTab,
        isStackBottom,
        forcedByConfig: opened.windowConfig.homeButton === true,
      }),
    }),
  }
}

export async function doNavigateTo(
  host: MiniAppHost,
  ref: StateRef,
  setState: SetState,
  applySideEffects: ApplySideEffects,
  payload: NavActionPayload,
  ack: Ack,
): Promise<void> {
  const { pagePath, query } = parseUrl(payload.params.url)
  if (!pagePath) {
    ack(false, 'navigateTo:fail invalid url')
    return
  }
  if (host.getTabBarConfig()?.list.some(item => normalizePath(item.pagePath) === pagePath)) {
    ack(false, 'navigateTo:fail can not navigateTo a tabbar page')
    return
  }

  const opened = await host.openPage(pagePath, query)
  // A pushed page is never the stack bottom: the home button shows here only
  // when the page config opts in, and then coexists with the back arrow.
  const newEntry = makePageEntry(host, opened, query, false)
  const { next, effects } = reduceNavigateTo(ref.current.shell, newEntry)
  commitShell(ref, setState, next)
  applySideEffects(effects)
  ack(true, 'navigateTo:ok')
}

export function doNavigateBack(
  ref: StateRef,
  setState: SetState,
  applySideEffects: ApplySideEffects,
  payload: NavActionPayload,
  ack: Ack,
): void {
  const rawDelta = payload.params.delta
  const delta = Number.isFinite(Number(rawDelta)) ? Number(rawDelta) : 1
  const result = reduceNavigateBack(ref.current.shell, delta)
  if ('error' in result) {
    ack(false, `navigateBack:fail ${result.error}`)
    return
  }
  commitShell(ref, setState, result.next)
  applySideEffects(result.effects)
  ack(true, 'navigateBack:ok')
}

export async function doRedirectTo(
  host: MiniAppHost,
  ref: StateRef,
  setState: SetState,
  applySideEffects: ApplySideEffects,
  payload: NavActionPayload,
  ack: Ack,
): Promise<void> {
  const { pagePath, query } = parseUrl(payload.params.url)
  if (!pagePath) {
    ack(false, 'redirectTo:fail invalid url')
    return
  }
  if (host.getTabBarConfig()?.list.some(item => normalizePath(item.pagePath) === pagePath)) {
    ack(false, 'redirectTo:fail can not redirectTo a tabbar page')
    return
  }
  const opened = await host.openPage(pagePath, query)
  // A redirect replaces the stack top in place, so the replacement page is the
  // stack bottom exactly when the page it replaced was. The old page's
  // wx.hideHomeButton does not carry over — this entry's nav bar is fresh.
  const newEntry = makePageEntry(host, opened, query, ref.current.shell.stack.length <= 1)
  const { next, effects } = reduceRedirectTo(ref.current.shell, newEntry)
  commitShell(ref, setState, next)
  applySideEffects(effects)
  ack(true, 'redirectTo:ok')
}

export async function doReLaunch(
  host: MiniAppHost,
  ref: StateRef,
  setState: SetState,
  applySideEffects: ApplySideEffects,
  payload: NavActionPayload,
  ack: Ack,
): Promise<void> {
  const { pagePath, query } = parseUrl(payload.params.url)
  if (!pagePath) {
    ack(false, 'reLaunch:fail invalid url')
    return
  }
  const opened = await host.openPage(pagePath, query)
  // reLaunch clears the whole stack, so its target is always the new bottom.
  const newEntry = makePageEntry(host, opened, query, true)
  const { next, effects } = reduceReLaunch(ref.current.shell, newEntry)
  commitShell(ref, setState, next)
  applySideEffects(effects)
  ack(true, 'reLaunch:ok')
}

export async function doSwitchTab(
  host: MiniAppHost,
  ref: StateRef,
  setState: SetState,
  applySideEffects: ApplySideEffects,
  payload: NavActionPayload,
  ack: Ack,
): Promise<void> {
  const { pagePath } = parseUrl(payload.params.url)
  if (!pagePath) {
    ack(false, 'switchTab:fail invalid url')
    return
  }
  if (!host.getTabBarConfig()?.list.some(item => normalizePath(item.pagePath) === pagePath)) {
    ack(false, `switchTab:fail not a tabBar page: ${pagePath}`)
    return
  }

  const before = ref.current.shell
  const cached = before.tabStacks[pagePath]
  let freshEntry: PageEntry | null = null
  if (!cached || cached.length === 0) {
    const opened = await host.openPage(pagePath, {})
    // A tabBar page never shows the home button, so its stack position is
    // immaterial to the verdict; it lands as its tab substack's bottom.
    freshEntry = makePageEntry(host, { ...opened, isTab: true }, {}, true)
  }

  const { next, effects } = reduceSwitchTab(ref.current.shell, pagePath, freshEntry)
  commitShell(ref, setState, next)
  applySideEffects(effects)
  ack(true, 'switchTab:ok')
}

/**
 * Whether the shell already sits on the terminal state "back to home" produces:
 * the home page alone in the stack, and — when it is a tabBar page — with its
 * own tab active.
 */
function isAtHome(shell: ShellState, home: string): boolean {
  if (shell.stack.length !== 1) return false
  const only = shell.stack[0]
  if (!only || normalizePath(only.pagePath) !== home) return false
  return !only.isTab || shell.currentTabPath === home
}

/**
 * "Back to home" — the shell's single routing authority for the nav-bar home
 * button, mirroring each native platform's `navigateHome` primitive. Which
 * verb reaches the home page comes from `resolveHomeNavAction`; each branch
 * ends on a stack holding nothing but the home page. Does nothing when the
 * home page is unknown.
 */
export async function doNavigateHome(
  host: MiniAppHost,
  ref: StateRef,
  setState: SetState,
  applySideEffects: ApplySideEffects,
  payload: ShellNavPayload,
  ack: Ack,
): Promise<void> {
  const action = resolveHomeNavAction(
    host.getHomePagePath(),
    host.getTabBarConfig(),
    ref.current.shell.stack.length,
  )
  if (!action) {
    ack(false, 'navigateHome:fail unknown home page')
    return
  }
  // Already at the terminal state this action aims for. A second press queued
  // while the first was still opening its page arrives here: re-running any
  // branch would reopen and tear down the very page just landed on, or re-show
  // a page that never left the screen.
  if (isAtHome(ref.current.shell, normalizePath(action.url))) {
    ack(true, `${action.name}:ok`)
    return
  }
  const forwarded: NavActionPayload = { ...payload, name: action.name, params: { url: action.url } }
  if (action.name === 'redirectTo') {
    await doRedirectTo(host, ref, setState, applySideEffects, forwarded, ack)
    return
  }
  if (action.name === 'reLaunch') {
    await doReLaunch(host, ref, setState, applySideEffects, forwarded, ack)
    return
  }

  const homeTabPath = normalizePath(action.url)
  const cached = ref.current.shell.tabStacks[homeTabPath]
  let freshEntry: PageEntry | null = null
  if (!cached || cached.length === 0) {
    const opened = await host.openPage(homeTabPath, {})
    freshEntry = makePageEntry(host, { ...opened, isTab: true }, {}, true)
  }
  const { next, effects } = reduceNavigateHomeToTab(ref.current.shell, homeTabPath, freshEntry)
  commitShell(ref, setState, next)
  applySideEffects(effects)
  ack(true, 'switchTab:ok')
}
