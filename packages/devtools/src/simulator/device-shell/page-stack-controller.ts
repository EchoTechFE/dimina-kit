/**
 * Pure state-transition layer for the simulator's per-tab page stacks.
 *
 * Mirrors how Native (iOS / Harmony) preserves an independent navigation
 * substack per tab: switching from tab A back to tab B restores tab B's
 * full stack (including any navigateTo'd pages on top of it) instead of
 * collapsing the previous pages.
 *
 * Routing operations return a new `ShellState` plus a list of `SideEffect`s
 * the host should issue (lifecycle notifications, page close calls, ack to
 * the bridge caller). Keeping the routing logic side-effect-free lets us
 * unit-test it without faking React / IPC.
 */
import type { PageWindowConfig } from '../../shared/bridge-channels'
import { makeDefaultNavigationBarState, type NavigationBarState } from './navigation-bar'

export interface PageEntry {
  bridgeId: string
  pagePath: string
  query: Record<string, unknown>
  isTab: boolean
  windowConfig: PageWindowConfig
  navBar: NavigationBarState
}

export interface ShellState {
  /** Current visible stack: bottom is the active tab page, top is whatever
   *  the last navigateTo / redirectTo / reLaunch produced. */
  stack: PageEntry[]
  /** Per-tab full stacks, keyed by normalized tab pagePath. Each entry's
   *  `stack[0]` is the tab page itself; entries above it are navigateTo'd. */
  tabStacks: Record<string, PageEntry[]>
  /** Path of the currently active tab, or null if there is no tab bar. */
  currentTabPath: string | null
}

export type SideEffect =
  | { kind: 'lifecycle'; bridgeId: string; event: 'pageShow' | 'pageHide' | 'pageUnload' }
  | { kind: 'closePage'; bridgeId: string }

export interface UrlParts {
  pagePath: string
  query: Record<string, string>
}

export interface ReduceResult {
  next: ShellState
  effects: SideEffect[]
}

// ── Helpers ────────────────────────────────────────────────────────────

export function normalizePath(p: string): string {
  return p ? p.replace(/^\/+/, '') : ''
}

export function parseUrl(raw: unknown): UrlParts {
  const str = typeof raw === 'string' ? raw : ''
  const [path, qs] = str.split('?')
  const query: Record<string, string> = {}
  if (qs) {
    for (const pair of qs.split('&')) {
      if (!pair) continue
      const eq = pair.indexOf('=')
      const k = eq >= 0 ? pair.slice(0, eq) : pair
      const v = eq >= 0 ? pair.slice(eq + 1) : ''
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v)
    }
  }
  return { pagePath: normalizePath(path), query }
}

export function makeInitialShellState(initial: PageEntry): ShellState {
  const tabStacks: Record<string, PageEntry[]> = {}
  if (initial.isTab) {
    tabStacks[initial.pagePath] = [initial]
  }
  return {
    stack: [initial],
    tabStacks,
    currentTabPath: initial.isTab ? initial.pagePath : null,
  }
}

/**
 * Snapshot the current visible stack back into `tabStacks` keyed by the
 * active tab path, so that switchTab can later restore it byte-for-byte
 * (including navigateTo'd pages above the tab root).
 */
function snapshotCurrentTabStack(state: ShellState): Record<string, PageEntry[]> {
  if (!state.currentTabPath) return state.tabStacks
  return { ...state.tabStacks, [state.currentTabPath]: [...state.stack] }
}

// ── Pure operations ─────────────────────────────────────────────────────

export function reduceNavigateTo(
  state: ShellState,
  newEntry: PageEntry,
): ReduceResult {
  const prevTop = state.stack[state.stack.length - 1]
  const nextStack = [...state.stack, newEntry]
  const next: ShellState = {
    ...state,
    stack: nextStack,
    // Mirror the new top into the current tab's substack so switchTab away
    // and back restores the navigateTo'd page.
    tabStacks: state.currentTabPath
      ? { ...state.tabStacks, [state.currentTabPath]: nextStack }
      : state.tabStacks,
  }
  return {
    next,
    effects: prevTop
      ? [{ kind: 'lifecycle', bridgeId: prevTop.bridgeId, event: 'pageHide' }]
      : [],
  }
}

export function reduceNavigateBack(
  state: ShellState,
  delta: number,
): ReduceResult | { error: string } {
  if (state.stack.length <= 1) {
    return { error: 'no page to back' }
  }
  const popCount = Math.min(
    Math.max(1, Number.isFinite(delta) ? delta : 1),
    state.stack.length - 1,
  )
  const popped = state.stack.slice(state.stack.length - popCount)
  const newStack = state.stack.slice(0, state.stack.length - popCount)
  const newTop = newStack[newStack.length - 1]

  const next: ShellState = {
    ...state,
    stack: newStack,
    // navigateBack mutates the live stack — also reflect it into the active
    // tab's substack so switchTab away/back doesn't resurrect popped pages.
    tabStacks: state.currentTabPath
      ? { ...state.tabStacks, [state.currentTabPath]: newStack }
      : state.tabStacks,
    currentTabPath: newTop.isTab ? newTop.pagePath : state.currentTabPath,
  }

  const effects: SideEffect[] = []
  // Popped pages are gone permanently (not part of any tab substack now).
  for (const entry of popped) {
    effects.push({ kind: 'lifecycle', bridgeId: entry.bridgeId, event: 'pageUnload' })
    effects.push({ kind: 'closePage', bridgeId: entry.bridgeId })
  }
  effects.push({ kind: 'lifecycle', bridgeId: newTop.bridgeId, event: 'pageShow' })
  return { next, effects }
}

export function reduceRedirectTo(
  state: ShellState,
  newEntry: PageEntry,
): ReduceResult {
  const prevTop = state.stack[state.stack.length - 1]
  const newStack = [...state.stack.slice(0, state.stack.length - 1), newEntry]
  const next: ShellState = {
    ...state,
    stack: newStack,
    tabStacks: state.currentTabPath
      ? { ...state.tabStacks, [state.currentTabPath]: newStack }
      : state.tabStacks,
  }
  const effects: SideEffect[] = []
  if (prevTop) {
    effects.push({ kind: 'lifecycle', bridgeId: prevTop.bridgeId, event: 'pageUnload' })
    effects.push({ kind: 'closePage', bridgeId: prevTop.bridgeId })
  }
  return { next, effects }
}

export function reduceReLaunch(
  state: ShellState,
  newEntry: PageEntry,
): ReduceResult {
  // Every previously-alive page is gone: the visible stack and every
  // tab substack get torn down.
  const aliveBridgeIds = new Set<string>()
  for (const entry of state.stack) aliveBridgeIds.add(entry.bridgeId)
  for (const entries of Object.values(state.tabStacks)) {
    for (const entry of entries) aliveBridgeIds.add(entry.bridgeId)
  }
  // The freshly-opened newEntry must not be unloaded even if its bridgeId
  // happens to collide (defensive — shouldn't in practice).
  aliveBridgeIds.delete(newEntry.bridgeId)

  const tabStacks: Record<string, PageEntry[]> = newEntry.isTab
    ? { [newEntry.pagePath]: [newEntry] }
    : {}

  const next: ShellState = {
    stack: [newEntry],
    tabStacks,
    currentTabPath: newEntry.isTab ? newEntry.pagePath : null,
  }

  const effects: SideEffect[] = []
  for (const bridgeId of aliveBridgeIds) {
    effects.push({ kind: 'lifecycle', bridgeId, event: 'pageUnload' })
    effects.push({ kind: 'closePage', bridgeId })
  }
  return { next, effects }
}

/**
 * switchTab semantics:
 *   1. Snapshot the current visible stack back into `tabStacks[prevTabPath]`
 *      so that any navigateTo'd pages on top of prev tab survive.
 *   2. If the target tab already has a saved substack, restore it as the
 *      visible stack. Otherwise build a fresh single-page stack with the
 *      newly-opened tab entry passed in by the caller.
 *   3. Lifecycle: pageHide prev top, pageShow restored top.
 *      No closePage is ever issued — every substack survives.
 */
export function reduceSwitchTab(
  state: ShellState,
  targetTabPath: string,
  /** Provided when the target tab has no cached substack yet — the caller
   *  has already opened a fresh page for it. Null/undefined when the target
   *  is being restored from `tabStacks`. */
  freshlyOpenedEntry: PageEntry | null,
): ReduceResult {
  const prevTop = state.stack[state.stack.length - 1]
  const tabStacksAfterSnapshot = snapshotCurrentTabStack(state)

  let nextStack: PageEntry[]
  const cached = tabStacksAfterSnapshot[targetTabPath]
  if (cached && cached.length > 0) {
    nextStack = cached
  } else if (freshlyOpenedEntry) {
    nextStack = [freshlyOpenedEntry]
  } else {
    throw new Error(
      `[page-stack] switchTab to ${targetTabPath} requires either a cached substack or a freshly-opened entry`,
    )
  }

  const next: ShellState = {
    ...state,
    stack: nextStack,
    tabStacks: {
      ...tabStacksAfterSnapshot,
      [targetTabPath]: nextStack,
    },
    currentTabPath: targetTabPath,
  }

  const newTop = nextStack[nextStack.length - 1]
  const effects: SideEffect[] = []
  if (prevTop && prevTop.bridgeId !== newTop.bridgeId) {
    effects.push({ kind: 'lifecycle', bridgeId: prevTop.bridgeId, event: 'pageHide' })
  }
  if (!freshlyOpenedEntry) {
    // Restored from cache — emit pageShow. (Newly-opened pages get their
    // own lifecycle from the renderer init path.)
    effects.push({ kind: 'lifecycle', bridgeId: newTop.bridgeId, event: 'pageShow' })
  }
  return { next, effects }
}

// ── Mount enumeration ───────────────────────────────────────────────────

/**
 * Returns the union of pages that must remain mounted in the DOM: every tab's
 * preserved substack plus any visible-stack pages not already covered (the
 * tab-less navigateTo case). Dedupes by bridgeId; only the current
 * top-of-stack entry is `visible: true`.
 *
 * ORDER IS STABLE and must NOT depend on which tab is currently active. An
 * Electron `<webview>` reloads its guest (fresh document, lost rendered DOM)
 * whenever React reparents it — which happens if this list reorders between
 * renders. Ordering by the active stack first would move the current tab to
 * the front on every switchTab, reloading and thus BLANKING every
 * already-rendered tab on return (the render data lives service-side and is
 * not re-pushed on a render-host reload). So we iterate `tabStacks` in its
 * stable insertion order and drive visibility purely off the `visible` flag +
 * CSS — never DOM position (only one page shows at a time, so DOM order is
 * cosmetically irrelevant).
 */
export interface MountedEntry {
  entry: PageEntry
  visible: boolean
}

export function enumerateMounted(state: ShellState): MountedEntry[] {
  const byBridgeId = new Map<string, MountedEntry>()
  const topId = state.stack[state.stack.length - 1]?.bridgeId
  const add = (entry: PageEntry): void => {
    if (!byBridgeId.has(entry.bridgeId)) {
      byBridgeId.set(entry.bridgeId, { entry, visible: entry.bridgeId === topId })
    }
  }
  // Tab substacks first, in stable insertion order. The visible stack is
  // mirrored into tabStacks[currentTabPath], so the active page is covered
  // here at its fixed position; the trailing loop only adds tab-less
  // navigateTo'd pages.
  for (const entries of Object.values(state.tabStacks)) {
    for (const entry of entries) add(entry)
  }
  for (const entry of state.stack) add(entry)
  return Array.from(byBridgeId.values())
}

// ── NavigationBar derivations ───────────────────────────────────────────

/**
 * Build the initial NavigationBar state from a page's merged window config
 * (app-config.json `window` ∪ page-level overrides). The fallback title is
 * used when `navigationBarTitleText` is unset (typically the appId).
 */
export function navBarFromConfig(
  config: PageWindowConfig,
  fallbackTitle: string,
): NavigationBarState {
  const background = (config.navigationBarBackgroundColor as string | undefined) ?? '#ffffff'
  const text = (config.navigationBarTextStyle as 'black' | 'white' | undefined) ?? 'black'
  const style = (config.navigationStyle as 'default' | 'custom' | undefined) ?? 'default'
  const title = (config.navigationBarTitleText as string | undefined) ?? fallbackTitle
  const homeButtonVisible = config.homeButton === true
  return makeDefaultNavigationBarState({
    title,
    backgroundColor: background,
    textStyle: text,
    style,
    homeButtonVisible,
  })
}

/**
 * Reduce one of the dynamic NavigationBar APIs (setNavigationBarTitle /
 * setNavigationBarColor / show|hideNavigationBarLoading / hideHomeButton)
 * over a page's nav-bar state. Unknown names fall through to `prev`.
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

// ── NavigationBar mutator (shared by IPC handler) ───────────────────────

/**
 * Apply a navBar mutator to whichever stack the page belongs to (visible
 * stack and/or any tab substack), keyed by bridgeId.
 */
export function mutatePageNavBar(
  state: ShellState,
  bridgeId: string,
  fn: (navBar: NavigationBarState) => NavigationBarState,
): ShellState {
  const replace = (entry: PageEntry): PageEntry =>
    entry.bridgeId === bridgeId ? { ...entry, navBar: fn(entry.navBar) } : entry
  const stack = state.stack.map(replace)
  const tabStacks: Record<string, PageEntry[]> = {}
  for (const [path, entries] of Object.entries(state.tabStacks)) {
    tabStacks[path] = entries.map(replace)
  }
  return { ...state, stack, tabStacks }
}
