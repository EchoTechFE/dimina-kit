import type { TabBarConfig, TabActionPayload } from '../../shared/bridge-channels'

export interface TabBarState {
  config: TabBarConfig | null
  visible: boolean
  badges: string[]
  redDots: boolean[]
}

export function makeInitialTabBarState(config: TabBarConfig | null): TabBarState {
  if (!config) {
    return { config: null, visible: false, badges: [], redDots: [] }
  }
  const len = config.list.length
  return {
    config: cloneConfig(config),
    visible: true,
    badges: Array.from({ length: len }, () => ''),
    redDots: Array.from({ length: len }, () => false),
  }
}

function cloneConfig(config: TabBarConfig): TabBarConfig {
  return {
    ...config,
    list: config.list.map(item => ({ ...item })),
  }
}

export type TabBarAction =
  | { kind: 'reset'; config: TabBarConfig | null }
  | { kind: 'visibility'; visible: boolean }
  | { kind: 'apply'; name: TabActionPayload['name']; params: Record<string, unknown> }

export interface ApplyResult {
  state: TabBarState
  ok: boolean
  errMsg: string
}

/**
 * Apply a single TabBar API mutation. Returns the new state plus ack metadata
 * so the device shell can forward success/fail back to the service-side
 * callback. Mirrors the validations in dimina-fe MiniApp.set/show/hideTabBar*.
 */
export function applyTabAction(prev: TabBarState, action: TabBarAction): ApplyResult {
  switch (action.kind) {
    case 'reset':
      return { state: makeInitialTabBarState(action.config), ok: true, errMsg: 'reset:ok' }
    case 'visibility':
      return {
        state: { ...prev, visible: action.visible },
        ok: true,
        errMsg: action.visible ? 'showTabBar:ok' : 'hideTabBar:ok',
      }
    case 'apply':
      return apply(prev, action.name, action.params)
  }
}

function apply(prev: TabBarState, name: TabActionPayload['name'], params: Record<string, unknown>): ApplyResult {
  if (!prev.config) {
    return { state: prev, ok: false, errMsg: `${name}:fail tabBar not configured` }
  }
  switch (name) {
    case 'setTabBarStyle':
      return setStyle(prev, params)
    case 'setTabBarItem':
      return setItem(prev, params)
    case 'showTabBar':
      return { state: { ...prev, visible: true }, ok: true, errMsg: 'showTabBar:ok' }
    case 'hideTabBar':
      return { state: { ...prev, visible: false }, ok: true, errMsg: 'hideTabBar:ok' }
    case 'setTabBarBadge':
      return setBadge(prev, params)
    case 'removeTabBarBadge':
      return removeBadge(prev, params)
    case 'showTabBarRedDot':
      return setRedDot(prev, params, true)
    case 'hideTabBarRedDot':
      return setRedDot(prev, params, false)
  }
}

function setStyle(prev: TabBarState, params: Record<string, unknown>): ApplyResult {
  if (!prev.config) {
    return { state: prev, ok: false, errMsg: 'setTabBarStyle:fail tabBar not configured' }
  }
  const next: TabBarConfig = { ...prev.config }
  const safe = (key: 'color' | 'selectedColor' | 'backgroundColor', value: unknown): void => {
    const s = sanitizeColor(value)
    if (s) next[key] = s
  }
  safe('color', params.color)
  safe('selectedColor', params.selectedColor)
  safe('backgroundColor', params.backgroundColor)
  if (params.borderStyle === 'black' || params.borderStyle === 'white') {
    next.borderStyle = params.borderStyle
  }
  return { state: { ...prev, config: next }, ok: true, errMsg: 'setTabBarStyle:ok' }
}

function setItem(prev: TabBarState, params: Record<string, unknown>): ApplyResult {
  const idx = validateIndex(prev, params)
  if (idx.err) return { state: prev, ok: false, errMsg: `setTabBarItem:fail ${idx.err}` }
  if (!prev.config) {
    return { state: prev, ok: false, errMsg: 'setTabBarItem:fail tabBar not configured' }
  }
  const oldItem = prev.config.list[idx.index]
  const updated = {
    ...oldItem,
    text: typeof params.text === 'string' ? params.text : oldItem.text,
    iconPath: typeof params.iconPath === 'string' ? params.iconPath : oldItem.iconPath,
    selectedIconPath:
      typeof params.selectedIconPath === 'string' ? params.selectedIconPath : oldItem.selectedIconPath,
  }
  const nextList = [...prev.config.list]
  nextList[idx.index] = updated
  return {
    state: { ...prev, config: { ...prev.config, list: nextList } },
    ok: true,
    errMsg: 'setTabBarItem:ok',
  }
}

function setBadge(prev: TabBarState, params: Record<string, unknown>): ApplyResult {
  const idx = validateIndex(prev, params)
  if (idx.err) return { state: prev, ok: false, errMsg: `setTabBarBadge:fail ${idx.err}` }
  const badges = [...prev.badges]
  badges[idx.index] = String(params.text ?? '')
  const redDots = [...prev.redDots]
  redDots[idx.index] = false
  return { state: { ...prev, badges, redDots }, ok: true, errMsg: 'setTabBarBadge:ok' }
}

function removeBadge(prev: TabBarState, params: Record<string, unknown>): ApplyResult {
  const idx = validateIndex(prev, params)
  if (idx.err) return { state: prev, ok: false, errMsg: `removeTabBarBadge:fail ${idx.err}` }
  const badges = [...prev.badges]
  badges[idx.index] = ''
  return { state: { ...prev, badges }, ok: true, errMsg: 'removeTabBarBadge:ok' }
}

function setRedDot(prev: TabBarState, params: Record<string, unknown>, on: boolean): ApplyResult {
  const idx = validateIndex(prev, params)
  if (idx.err) {
    return {
      state: prev,
      ok: false,
      errMsg: `${on ? 'showTabBarRedDot' : 'hideTabBarRedDot'}:fail ${idx.err}`,
    }
  }
  const redDots = [...prev.redDots]
  redDots[idx.index] = on
  const badges = [...prev.badges]
  if (on) badges[idx.index] = ''
  return {
    state: { ...prev, redDots, badges },
    ok: true,
    errMsg: `${on ? 'showTabBarRedDot' : 'hideTabBarRedDot'}:ok`,
  }
}

function validateIndex(prev: TabBarState, params: Record<string, unknown>): { index: number; err: string | null } {
  const list = prev.config?.list ?? []
  const raw = params.index
  const index = Number(raw)
  if (!list.length) return { index: -1, err: 'tabBar not configured' }
  if (raw === undefined || raw === null || !Number.isInteger(index) || index < 0 || index >= list.length) {
    return { index: -1, err: `invalid index ${raw}` }
  }
  return { index, err: null }
}

/**
 * Same color sanitizer as dimina-fe MiniApp._sanitizeCssColor: hex / rgba /
 * hsla pass through; anything containing style-escape characters is rejected.
 */
function sanitizeColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (!v || v.length > 64) return null
  if (/[<>"';{}()\\]/.test(v)) {
    if (/^(?:rgb|rgba|hsl|hsla)\(\s*[\d.,%\s/-]+\)$/i.test(v)) return v
    return null
  }
  return v
}
