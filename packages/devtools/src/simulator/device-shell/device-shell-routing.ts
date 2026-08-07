/**
 * Routing operations for DeviceShell (navigateTo / navigateBack / redirectTo /
 * reLaunch / switchTab): each opens pages through the SimulatorMiniApp, feeds
 * the pure reducers in page-stack-controller, commits the new ShellState via
 * the host's setState and applies the returned side effects. Kept out of
 * device-shell.tsx so that file stays presentational glue.
 *
 * Every operation that mints a PageEntry also decides that page's home-button
 * visibility here, because the verdict depends on where the new page lands in
 * the stack — knowledge the reducers and the page config alone do not have.
 */
import type { NavActionPayload } from '../../shared/bridge-channels'
import type { SimulatorMiniApp } from '../simulator-mini-app'
import type { TabBarState } from './tab-bar-state'
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
} from './page-stack-controller'
import {
  reduceNavigateHomeToTab,
  resolveHomeNavAction,
  shouldShowHomeButton,
} from './navigate-home'

export interface DeviceShellState {
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

export type StateRef = React.MutableRefObject<DeviceShellState>
export type SetState = React.Dispatch<React.SetStateAction<DeviceShellState>>
export type Ack = (ok: boolean, errMsg: string) => void
export type ApplySideEffects = (effects: SideEffect[]) => void

/**
 * Build the PageEntry for a page the host just opened, with its home button
 * resolved against the app's home page and the stack position the caller knows
 * this page is landing at.
 */
function makePageEntry(
  miniApp: SimulatorMiniApp,
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
    navBar: navBarFromConfig(opened.windowConfig, miniApp.appId, {
      homeButtonVisible: shouldShowHomeButton({
        pagePath: opened.pagePath,
        homePagePath: miniApp.getHomePagePath(),
        isTab: opened.isTab,
        isStackBottom,
        forcedByConfig: opened.windowConfig.homeButton === true,
      }),
    }),
  }
}

export async function doNavigateTo(
  miniApp: SimulatorMiniApp,
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
  if (miniApp.getTabBarConfig()?.list.some(item => normalizePath(item.pagePath) === pagePath)) {
    ack(false, 'navigateTo:fail can not navigateTo a tabbar page')
    return
  }

  const opened = await miniApp.openPage(pagePath, query)
  // A pushed page is never the stack bottom: the home button shows here only
  // when the page config opts in, and then coexists with the back arrow.
  const newEntry = makePageEntry(miniApp, opened, query, false)
  const { next, effects } = reduceNavigateTo(ref.current.shell, newEntry)
  setState(prev => ({ ...prev, shell: next }))
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
  setState(prev => ({ ...prev, shell: result.next }))
  applySideEffects(result.effects)
  ack(true, 'navigateBack:ok')
}

export async function doRedirectTo(
  miniApp: SimulatorMiniApp,
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
  if (miniApp.getTabBarConfig()?.list.some(item => normalizePath(item.pagePath) === pagePath)) {
    ack(false, 'redirectTo:fail can not redirectTo a tabbar page')
    return
  }
  const opened = await miniApp.openPage(pagePath, query)
  // A redirect replaces the stack top in place, so the replacement page is the
  // stack bottom exactly when the page it replaced was. The old page's
  // wx.hideHomeButton does not carry over — this entry's nav bar is fresh.
  const newEntry = makePageEntry(miniApp, opened, query, ref.current.shell.stack.length <= 1)
  const { next, effects } = reduceRedirectTo(ref.current.shell, newEntry)
  setState(prev => ({ ...prev, shell: next }))
  applySideEffects(effects)
  ack(true, 'redirectTo:ok')
}

export async function doReLaunch(
  miniApp: SimulatorMiniApp,
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
  const opened = await miniApp.openPage(pagePath, query)
  // reLaunch clears the whole stack, so its target is always the new bottom.
  const newEntry = makePageEntry(miniApp, opened, query, true)
  const { next, effects } = reduceReLaunch(ref.current.shell, newEntry)
  setState(prev => ({ ...prev, shell: next }))
  applySideEffects(effects)
  ack(true, 'reLaunch:ok')
}

export async function doSwitchTab(
  miniApp: SimulatorMiniApp,
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
  if (!miniApp.getTabBarConfig()?.list.some(item => normalizePath(item.pagePath) === pagePath)) {
    ack(false, `switchTab:fail not a tabBar page: ${pagePath}`)
    return
  }

  const before = ref.current.shell
  const cached = before.tabStacks[pagePath]
  let freshEntry: PageEntry | null = null
  if (!cached || cached.length === 0) {
    const opened = await miniApp.openPage(pagePath, {})
    // A tabBar page never shows the home button, so its stack position is
    // immaterial to the verdict; it lands as its tab substack's bottom.
    freshEntry = makePageEntry(miniApp, { ...opened, isTab: true }, {}, true)
  }

  const { next, effects } = reduceSwitchTab(ref.current.shell, pagePath, freshEntry)
  setState(prev => ({ ...prev, shell: next }))
  applySideEffects(effects)
  ack(true, 'switchTab:ok')
}

/**
 * "Back to home" — the shell's single routing authority for the nav-bar home
 * button, mirroring each native platform's `navigateHome` primitive. Which
 * verb reaches the home page comes from `resolveHomeNavAction`; each branch
 * ends on a stack holding nothing but the home page. Does nothing when the
 * home page is unknown.
 */
export async function doNavigateHome(
  miniApp: SimulatorMiniApp,
  ref: StateRef,
  setState: SetState,
  applySideEffects: ApplySideEffects,
  payload: ShellNavPayload,
  ack: Ack,
): Promise<void> {
  const action = resolveHomeNavAction(
    miniApp.getHomePagePath(),
    miniApp.getTabBarConfig(),
    ref.current.shell.stack.length,
  )
  if (!action) {
    ack(false, 'navigateHome:fail unknown home page')
    return
  }
  const forwarded: NavActionPayload = { ...payload, name: action.name, params: { url: action.url } }
  if (action.name === 'redirectTo') {
    await doRedirectTo(miniApp, ref, setState, applySideEffects, forwarded, ack)
    return
  }
  if (action.name === 'reLaunch') {
    await doReLaunch(miniApp, ref, setState, applySideEffects, forwarded, ack)
    return
  }

  const homeTabPath = normalizePath(action.url)
  const cached = ref.current.shell.tabStacks[homeTabPath]
  let freshEntry: PageEntry | null = null
  if (!cached || cached.length === 0) {
    const opened = await miniApp.openPage(homeTabPath, {})
    freshEntry = makePageEntry(miniApp, { ...opened, isTab: true }, {}, true)
  }
  const { next, effects } = reduceNavigateHomeToTab(ref.current.shell, homeTabPath, freshEntry)
  setState(prev => ({ ...prev, shell: next }))
  applySideEffects(effects)
  ack(true, 'switchTab:ok')
}
