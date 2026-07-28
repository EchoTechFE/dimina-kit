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
  onMoreClick?: () => void
}

const TIMING_FUNC_MAP: Record<NonNullable<NavigationBarState['colorAnimation']>['timingFunc'], string> = {
  linear: 'linear',
  easeIn: 'ease-in',
  easeOut: 'ease-out',
  easeInOut: 'ease-in-out',
}

// Native back-arrow glyphs are filled wedges, not a stroked chevron.
// iOS: exact path from Assets.xcassets/arrow-back-{dark,light}.imageset (both
// color variants share this path). Android: Icons.AutoMirrored.Filled.KeyboardArrowLeft
// is a compiled androidx vector with no source in this repo to read; its path is
// the standard Material Design "keyboard_arrow_left" glyph, verified against
// google/material-design-icons (src/hardware/keyboard_arrow_left/materialicons/24px.svg)
// rather than reproduced from memory.
const BACK_ARROW_PATH: Record<NavBarPlatform, string> = {
  ios: 'M17.51 3.87L15.73 2.1 5.84 12l9.9 9.9 1.77-1.77L9.38 12l8.13-8.13z',
  android: 'M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z',
}

/**
 * Simulator navigation bar aligned with WeChat MiniProgram spec
 * (see packages/devtools/docs/native-bridge-protocol.md NavigationBar section):
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
  onMoreClick,
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
  // Native back-arrow icon size differs per platform: iOS's arrow-back
  // SVG asset renders at its 24pt viewBox; Android's
  // Icons.AutoMirrored.Filled.KeyboardArrowLeft is explicitly sized 30dp
  // (DiminaActivity.kt CenterAlignedTopAppBar navigationIcon).
  const backIconSize = platform === 'android' ? 30 : 24

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
                  <svg viewBox="0 0 24 24" width={backIconSize} height={backIconSize} aria-hidden="true">
                    <path d={BACK_ARROW_PATH[platform]} fill="currentColor" />
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
        onMoreClick={onMoreClick}
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
