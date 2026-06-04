import './menu-capsule.css'
import type { NavigationBarTextStyle, NavBarPlatform } from './navigation-bar'

// Geometry helpers live in menu-button-geometry.ts so the service-host sync
// impl (no React) and this component share one source of truth.
export { getMenuCapsuleRect, type MenuButtonRect as MenuCapsuleRect } from './menu-button-geometry'

export interface MenuCapsuleProps {
  platform: NavBarPlatform
  statusBarHeight: number
  textStyle: NavigationBarTextStyle
}

/**
 * Static visual stand-in for the WeChat capsule (more / close).
 * No click handler — WeChat does not expose a tap event for the capsule.
 */
export function MenuCapsule({ platform, statusBarHeight, textStyle }: MenuCapsuleProps) {
  const width = platform === 'ios' ? 87 : 95
  const height = 32
  const top = statusBarHeight + (platform === 'ios' ? 4 : 6)
  const right = platform === 'ios' ? 7 : 10

  return (
    <div
      className={`menu-capsule menu-capsule--${textStyle}`}
      style={{ width, height, top, right }}
      aria-hidden="true"
    >
      <div className="menu-capsule__more">
        <span /><span /><span />
      </div>
      <div className="menu-capsule__divider" />
      <div className="menu-capsule__close">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  )
}
