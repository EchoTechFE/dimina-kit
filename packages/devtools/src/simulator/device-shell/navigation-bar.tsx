import { useMemo } from 'react'
import { MenuCapsule } from './menu-capsule'
import './navigation-bar.css'

export type NavigationBarTextStyle = 'white' | 'black'
export type NavigationStyle = 'default' | 'custom'
export type NavBarPlatform = 'ios' | 'android'

export interface NavigationBarState {
  title: string
  backgroundColor: string
  textStyle: NavigationBarTextStyle
  style: NavigationStyle
  loading: boolean
  homeButtonVisible: boolean
  /**
   * Optional CSS transition duration set by `wx.setNavigationBarColor`.
   * WeChat supports linear / easeIn / easeOut / easeInOut.
   */
  colorAnimation?: {
    durationMs: number
    timingFunc: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'
  }
}

export interface NavigationBarProps {
  state: NavigationBarState
  /** Page stack depth — when >1 a back arrow appears. */
  stackDepth: number
  platform: NavBarPlatform
  statusBarHeight: number
  /** Total nav bar height (excluding status bar). 44 by spec. */
  navBarHeight: number
  onBack?: () => void
  onHome?: () => void
}

const TIMING_FUNC_MAP: Record<NonNullable<NavigationBarState['colorAnimation']>['timingFunc'], string> = {
  linear: 'linear',
  easeIn: 'ease-in',
  easeOut: 'ease-out',
  easeInOut: 'ease-in-out',
}

/**
 * Simulator navigation bar aligned with WeChat MiniProgram spec
 * (see packages/devtools/docs/simulator-refactor.md NavigationBar section):
 *
 * - `style: custom` hides the bar entirely, capsule stays.
 * - Title default-center on iOS, default-left on Android (per official guidance).
 * - Back arrow appears when stackDepth > 1; otherwise home button when configured.
 * - `textStyle` drives both title color AND status bar foreground (handled by parent).
 * - Color transitions follow `wx.setNavigationBarColor.animation` semantics.
 */
export function NavigationBar({
  state,
  stackDepth,
  platform,
  statusBarHeight,
  navBarHeight,
  onBack,
  onHome,
}: NavigationBarProps) {
  const transition = useMemo(() => {
    if (!state.colorAnimation || state.colorAnimation.durationMs <= 0) return undefined
    const timing = TIMING_FUNC_MAP[state.colorAnimation.timingFunc] ?? 'linear'
    return `background-color ${state.colorAnimation.durationMs}ms ${timing}, color ${state.colorAnimation.durationMs}ms ${timing}`
  }, [state.colorAnimation])

  const isCustom = state.style === 'custom'
  const showBack = stackDepth > 1
  const showHome = !showBack && state.homeButtonVisible
  const titleAlign = platform === 'ios' ? 'center' : 'left'

  const containerStyle: React.CSSProperties = {
    backgroundColor: state.backgroundColor,
    color: state.textStyle === 'white' ? '#ffffff' : '#000000',
    height: statusBarHeight + navBarHeight,
    paddingTop: statusBarHeight,
    transition,
  }

  return (
    <header
      className={`nav-bar nav-bar--${platform} nav-bar--${state.textStyle}${isCustom ? ' nav-bar--custom' : ''}`}
      style={containerStyle}
      aria-hidden={isCustom}
    >
      {!isCustom && (
        <div
          className="nav-bar__row"
          style={{ height: navBarHeight, justifyContent: titleAlign === 'center' ? 'center' : 'flex-start' }}
        >
          {(showBack || showHome) && (
            <div className="nav-bar__leading">
              {showBack && (
                <button
                  type="button"
                  className="nav-bar__back"
                  aria-label="Back"
                  onClick={onBack}
                >
                  <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
                    <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
              {showHome && (
                <button
                  type="button"
                  className="nav-bar__home"
                  aria-label="Home"
                  onClick={onHome}
                >
                  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                    <path d="M3 12l9-9 9 9M5 10v10h14V10" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
            </div>
          )}
          <div
            className={`nav-bar__title nav-bar__title--${titleAlign}`}
            style={{ color: state.textStyle === 'white' ? '#ffffff' : '#000000' }}
          >
            {state.loading && (
              <span className="nav-bar__spinner" aria-hidden="true" />
            )}
            <span className="nav-bar__title-text">{state.title}</span>
          </div>
        </div>
      )}
      <MenuCapsule
        platform={platform}
        statusBarHeight={statusBarHeight}
        textStyle={state.textStyle}
      />
    </header>
  )
}

export function makeDefaultNavigationBarState(initial?: Partial<NavigationBarState>): NavigationBarState {
  return {
    title: initial?.title ?? '',
    backgroundColor: initial?.backgroundColor ?? '#000000',
    textStyle: initial?.textStyle ?? 'white',
    style: initial?.style ?? 'default',
    loading: initial?.loading ?? false,
    homeButtonVisible: initial?.homeButtonVisible ?? false,
    colorAnimation: initial?.colorAnimation,
  }
}
