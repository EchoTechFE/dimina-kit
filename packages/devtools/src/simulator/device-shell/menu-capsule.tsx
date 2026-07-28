import './menu-capsule.css'
import type { NavBarPlatform } from './navigation-bar'
import {
  MENU_CAPSULE_HEIGHT,
  MENU_CAPSULE_TRAILING_SPACING,
  MENU_CAPSULE_WIDTH,
  getMenuCapsuleTopOffset,
} from './menu-button-geometry'

// Geometry helpers live in menu-button-geometry.ts so the service-host sync
// impl (no React) and this component share one source of truth.
export { getMenuCapsuleRect, type MenuButtonRect as MenuCapsuleRect } from './menu-button-geometry'

export interface MenuCapsuleProps {
  platform: NavBarPlatform
  statusBarHeight: number
  onMoreClick?: () => void
}

/**
 * Capsule bar (more / close) rendered in the navigation-bar area.
 * The "more" dot button opens the capsule menu popup via `onMoreClick`.
 *
 * Native containers render the capsule as an opaque white pill with dark
 * icons regardless of the nav bar's textStyle (see MenuButtonGeometry.kt /
 * MenuAPI.swift), so this does not theme off navBar textStyle either.
 */
export function MenuCapsule({ platform, statusBarHeight, onMoreClick }: MenuCapsuleProps) {
  const top = statusBarHeight + getMenuCapsuleTopOffset(platform)

  return (
    <div
      className="menu-capsule"
      style={{ width: MENU_CAPSULE_WIDTH, height: MENU_CAPSULE_HEIGHT, top, right: MENU_CAPSULE_TRAILING_SPACING }}
      aria-hidden="true"
    >
      <div className="menu-capsule__more" onClick={onMoreClick}>
        <span className="menu-capsule__dot menu-capsule__dot--side" />
        <span className="menu-capsule__dot menu-capsule__dot--mid" />
        <span className="menu-capsule__dot menu-capsule__dot--side" />
      </div>
      <div className="menu-capsule__divider" />
      <div className="menu-capsule__close">
        {/* Native draws a hollow ring + filled center dot, not an "X" — see
            DiminaActivity.kt#MiniProgramCapsuleButton / DMPPageController.swift#makeCapsuleCloseImage
            (both: 22x22 canvas, ring r=7.8 stroke=2.4, center dot r=3.1). */}
        <svg viewBox="0 0 22 22" width="22" height="22" aria-hidden="true">
          <circle cx="11" cy="11" r="7.8" fill="none" stroke="currentColor" strokeWidth="2.4" />
          <circle cx="11" cy="11" r="3.1" fill="currentColor" />
        </svg>
      </div>
    </div>
  )
}
