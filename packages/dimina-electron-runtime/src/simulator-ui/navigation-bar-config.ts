/**
 * Everything that produces a `NavigationBarState`: the initial state a page's merged window config implies, and the dynamic `wx.setNavigationBar*` / `wx.hideHomeButton` mutations applied over it afterwards.
 *
 * Kept apart from the page-stack reducers — these touch one page's bar, never the stack — and from `navigation-bar.tsx`, which only renders the state.
 */
import type { PageWindowConfig } from '../shared/bridge-channels.js'
import { makeDefaultNavigationBarState, type NavigationBarState } from './navigation-bar.js'

/**
 * Build the initial NavigationBar state from a page's merged window config (app-config.json `window` ∪ page-level overrides).
 * The fallback title is used when `navigationBarTitleText` is unset (typically the appId). `opts.homeButtonVisible` sets the home button verbatim — callers that know the page's stack position pass the `shouldShowHomeButton` verdict here so the home/tab exclusions apply.
 * Without it only the page config speaks.
 */
export function navBarFromConfig(
  config: PageWindowConfig,
  fallbackTitle: string,
  opts?: { homeButtonVisible?: boolean },
): NavigationBarState {
  const background = (config.navigationBarBackgroundColor as string | undefined) ?? '#ffffff'
  const text = (config.navigationBarTextStyle as 'black' | 'white' | undefined) ?? 'black'
  const style = (config.navigationStyle as 'default' | 'custom' | undefined) ?? 'default'
  const title = (config.navigationBarTitleText as string | undefined) ?? fallbackTitle
  const homeButtonVisible = opts?.homeButtonVisible ?? (config.homeButton === true)
  return makeDefaultNavigationBarState({
    title,
    backgroundColor: background,
    textStyle: text,
    style,
    homeButtonVisible,
  })
}

/**
 * Reduce one of the dynamic NavigationBar APIs (setNavigationBarTitle / setNavigationBarColor / show|hideNavigationBarLoading / hideHomeButton) over a page's nav-bar state.
 * Unknown names fall through to `prev`.
 */
export function reduceNavBar(
  prev: NavigationBarState,
  name: string,
  params: Record<string, unknown>,
): NavigationBarState {
  switch (name) {
    case 'setNavigationBarTitle':
      return { ...prev, title: typeof params.title === 'string' ? params.title : prev.title }
    case 'setNavigationBarColor':
      return applyColorMutation(prev, params)
    case 'showNavigationBarLoading':
      return { ...prev, loading: true }
    case 'hideNavigationBarLoading':
      return { ...prev, loading: false }
    case 'hideHomeButton':
      return { ...prev, homeButtonVisible: false }
    default:
      return prev
  }
}

const ALLOWED_TIMING_FUNCS = ['linear', 'easeIn', 'easeOut', 'easeInOut'] as const
type TimingFunc = typeof ALLOWED_TIMING_FUNCS[number]

/**
 * Apply `wx.setNavigationBarColor` to a navBar state:
 * - frontColor must be `#ffffff` or `#000000` (WeChat constraint); other
 *   values are ignored and previous textStyle is preserved.
 * - backgroundColor passes through if it's a string.
 * - animation `{ duration, timingFunc }` is normalized to ms + a whitelisted
 *   timingFunc, defaulting to 0ms / linear when missing or invalid.
 */
export function applyColorMutation(
  prev: NavigationBarState,
  params: Record<string, unknown>,
): NavigationBarState {
  const front = typeof params.frontColor === 'string' ? params.frontColor.toLowerCase() : undefined
  const textStyle = front === '#ffffff' ? 'white' : front === '#000000' ? 'black' : prev.textStyle
  const background = typeof params.backgroundColor === 'string' ? params.backgroundColor : prev.backgroundColor

  const animation = (() => {
    const raw = params.animation
    if (!raw || typeof raw !== 'object') return undefined
    const obj = raw as Record<string, unknown>
    const duration = typeof obj.duration === 'number' && Number.isFinite(obj.duration) ? Math.max(0, obj.duration) : 0
    const timing = typeof obj.timingFunc === 'string' ? obj.timingFunc : 'linear'
    const timingFunc: TimingFunc = (ALLOWED_TIMING_FUNCS as readonly string[]).includes(timing)
      ? (timing as TimingFunc)
      : 'linear'
    return { durationMs: duration, timingFunc }
  })()

  return {
    ...prev,
    textStyle,
    backgroundColor: background,
    colorAnimation: animation,
  }
}
