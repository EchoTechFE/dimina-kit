import './tab-bar.css'
import type { TabBarState } from './tab-bar-state'

export interface TabBarProps {
  state: TabBarState
  /** Normalized (no leading slash) path of the currently active tab. */
  currentPath: string | null
  /** Used to resolve relative iconPath references against the bundle root. */
  resourceBaseUrl: string | null
  appId: string
  onSwitch: (pagePath: string) => void
  /** Device bottom safe-area inset (px). The tabBar background extends through
   *  it (padding-bottom) so the home-indicator strip is the tabBar's color, as
   *  on WeChat. 0 on home-button devices. */
  bottomInset?: number
}

export function TabBar({ state, currentPath, resourceBaseUrl, appId, onSwitch, bottomInset = 0 }: TabBarProps) {
  if (!state.config || !state.visible) return null

  const { color, selectedColor, backgroundColor, borderStyle, list } = state.config
  const normalColor = color || '#999999'
  const activeColor = selectedColor || '#1890ff'
  const bg = backgroundColor || '#ffffff'
  const borderColor = borderStyle === 'white' ? '#ffffff' : '#e0e0e0'

  return (
    <div
      className="dmb-tab-bar"
      style={{ backgroundColor: bg, borderTopColor: borderColor, paddingBottom: bottomInset }}
      role="tablist"
      aria-label="TabBar"
    >
      {list.map((item, index) => {
        const normalized = normalizePath(item.pagePath)
        const selected = normalized === currentPath
        const iconUrl = resolveIcon(
          selected ? item.selectedIconPath ?? item.iconPath : item.iconPath,
          resourceBaseUrl,
          appId,
        )
        const badge = state.badges[index] ?? ''
        const redDot = state.redDots[index] ?? false
        return (
          <button
            type="button"
            key={`${normalized}-${index}`}
            className={`dmb-tab-bar__item${selected ? ' is-selected' : ''}`}
            role="tab"
            aria-selected={selected}
            onClick={() => onSwitch(normalized)}
          >
            {iconUrl && (
              <span className="dmb-tab-bar__icon-slot">
                <img
                  className="dmb-tab-bar__icon"
                  src={iconUrl}
                  alt=""
                  onError={(event) => {
                    (event.currentTarget as HTMLImageElement).style.display = 'none'
                  }}
                />
              </span>
            )}
            <span
              className="dmb-tab-bar__text"
              style={{ color: selected ? activeColor : normalColor }}
            >
              {item.text || ''}
            </span>
            {badge && <span className="dmb-tab-bar__badge">{badge}</span>}
            {!badge && redDot && <span className="dmb-tab-bar__red-dot" />}
          </button>
        )
      })}
    </div>
  )
}

function normalizePath(p: string): string {
  return p ? p.replace(/^\/+/, '') : ''
}

export function resolveIcon(
  iconPath: string | undefined,
  baseUrl: string | null,
  appId: string,
): string | null {
  if (!iconPath) return null
  const raw = iconPath.trim()
  if (!raw) return null
  if (/^(?:data:|blob:|https?:|\/\/)/i.test(raw)) return raw
  if (!baseUrl) return null
  const local = raw.replace(/^\/+/, '').replace(/^\.\//, '')
  // `resourceBaseUrl` is the dev-server origin (its root), and the compiler
  // rewrites tabBar iconPath to an absolute, server-root path
  // `/<appId>/main/static/…`. So an already-rooted path joins onto the base
  // verbatim — the `<appId>` segment is part of the URL, NOT to be stripped.
  if (local.startsWith(`${appId}/`)) {
    return joinUrl(baseUrl, local)
  }
  // Bare in-package relative paths (compiler didn't rewrite) sit under the
  // package root `<appId>/main`.
  return joinUrl(baseUrl, `${appId}/main/${local}`)
}

function joinUrl(base: string, rel: string): string {
  const b = base.endsWith('/') ? base : `${base}/`
  return `${b}${rel.replace(/^\/+/, '')}`
}
