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
import type { PageWindowConfig } from '../shared/bridge-channels.js'
import type { NavigationBarState } from './navigation-bar.js'

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

/**
 * Whoever becomes the visible top gets `pageShow` — a page opened for this very transition included.
 * Nothing else in this container announces a page's visibility: the render host reports resources and readiness, never that its page is on screen, and the service treats a page as hidden until a `pageShow` says otherwise (`Runtime.pageStates[bridgeId].shown`).
 * Without one the page's `onShow` never runs and everything the service gates on visibility — `Page.onResize` among them — is dropped for the life of that page.
 *
 * Re-announcing a page that is already shown is inert (the service's `pageShow` returns early when `shown`), so callers do not have to know whether the top they are installing is fresh or restored from a tab cache.
 */
function showTop(bridgeId: string): SideEffect {
  return { kind: 'lifecycle', bridgeId, event: 'pageShow' }
}

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

/** Decode one `key=value` query-string segment, or null for an empty key/pair. */
function parseQueryPair(pair: string): [string, string] | null {
  if (!pair) return null
  const eq = pair.indexOf('=')
  const k = eq >= 0 ? pair.slice(0, eq) : pair
  const v = eq >= 0 ? pair.slice(eq + 1) : ''
  if (!k) return null
  return [decodeURIComponent(k), decodeURIComponent(v)]
}

function parseQueryString(qs: string): Record<string, string> {
  const query: Record<string, string> = {}
  for (const pair of qs.split('&')) {
    const parsed = parseQueryPair(pair)
    if (parsed) query[parsed[0]] = parsed[1]
  }
  return query
}

export function parseUrl(raw: unknown): UrlParts {
  const str = typeof raw === 'string' ? raw : ''
  const [path, qs] = str.split('?')
  return { pagePath: normalizePath(path), query: qs ? parseQueryString(qs) : {} }
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

/** Every page a state keeps alive: the visible stack plus every tab substack. */
export function collectAlivePages(state: ShellState): Set<string> {
  const alive = new Set<string>()
  for (const entry of state.stack) alive.add(entry.bridgeId)
  for (const entries of Object.values(state.tabStacks)) {
    for (const entry of entries) alive.add(entry.bridgeId)
  }
  return alive
}

/**
 * Tear-down effects for every page a transition drops from state. A page that
 * survives in the visible stack or in any tab substack is untouched; one that
 * appears in neither no longer exists anywhere, and dropping it without a
 * closePage would strand its render host in main's page ledger.
 */
function teardownDropped(before: ShellState, after: ShellState): SideEffect[] {
  const alive = collectAlivePages(after)
  const effects: SideEffect[] = []
  for (const bridgeId of collectAlivePages(before)) {
    if (alive.has(bridgeId)) continue
    effects.push({ kind: 'lifecycle', bridgeId, event: 'pageUnload' })
    effects.push({ kind: 'closePage', bridgeId })
  }
  return effects
}

/** Mirror a redirect into the tab caches: normally the active tab tracks the
 *  new stack, but a tab that just lost its root page drops out entirely. */
function tabStacksAfterRedirect(
  state: ShellState,
  newStack: PageEntry[],
  losesTabRoot: boolean,
): Record<string, PageEntry[]> {
  if (!state.currentTabPath) return state.tabStacks
  if (!losesTabRoot) return { ...state.tabStacks, [state.currentTabPath]: newStack }
  const remaining = { ...state.tabStacks }
  delete remaining[state.currentTabPath]
  return remaining
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
  const effects: SideEffect[] = []
  if (prevTop) {
    effects.push({ kind: 'lifecycle', bridgeId: prevTop.bridgeId, event: 'pageHide' })
  }
  effects.push(showTop(newEntry.bridgeId))
  return { next, effects }
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
  // Redirecting off the bottom of a tab's substack destroys that tab's root
  // page, so the substack must not go on pointing at it: a cache whose [0] is a
  // non-tab page gets restored later as if it were the tab itself, and "back to
  // home" lands on it instead of the home page. The tab is left with no cache —
  // switching to it opens it fresh, which is what its destroyed root requires.
  const losesTabRoot = !!state.currentTabPath && state.stack.length <= 1 && !newEntry.isTab
  const next: ShellState = {
    ...state,
    stack: newStack,
    tabStacks: tabStacksAfterRedirect(state, newStack, losesTabRoot),
    currentTabPath: losesTabRoot ? null : state.currentTabPath,
  }
  const effects: SideEffect[] = []
  if (prevTop) {
    effects.push({ kind: 'lifecycle', bridgeId: prevTop.bridgeId, event: 'pageUnload' })
    effects.push({ kind: 'closePage', bridgeId: prevTop.bridgeId })
  }
  effects.push(showTop(newEntry.bridgeId))
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
  effects.push(showTop(newEntry.bridgeId))
  return { next, effects }
}

/**
 * switchTab semantics:
 *   1. Snapshot the current visible stack back into `tabStacks[prevTabPath]`
 *      so that any navigateTo'd pages on top of prev tab survive.
 *   2. If the target tab already has a saved substack, restore it as the
 *      visible stack. Otherwise build a fresh single-page stack with the
 *      newly-opened tab entry passed in by the caller.
 *   3. Lifecycle: pageHide prev top, pageShow the new top (restored or fresh).
 *   4. Every substack survives, so a page held by any tab is never torn down.
 *      A page held by none — the visible page of a session with no active tab —
 *      belongs to nothing the switch preserves and gets pageUnload + closePage.
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
  // A page the switch leaves in no stack at all is gone for good — the visible
  // page of a session with no active tab (a deep-linked non-tab launch page, or
  // one a redirect took out of the tab caches) belongs to nothing that switchTab
  // preserves. Pages still held by a tab substack survive untouched: keeping
  // them is the per-tab cache semantics this shell mirrors from iOS/Harmony.
  effects.push(...teardownDropped(state, next))
  if (!prevTop || prevTop.bridgeId !== newTop.bridgeId) {
    effects.push(showTop(newTop.bridgeId))
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

// ── Page surface derivations ────────────────────────────────────────────

/**
 * The page's own body background — WeChat/Android/Harmony parity: primes the
 * native render surface with `window.backgroundColor` (page-level override ∪
 * app-level default) BEFORE the page's own document paints, so switching
 * pages never flashes Chromium's default white during the gap between guest
 * attach and the new page's first composited frame. Defaults to `#ffffff`
 * when unconfigured (same default Android's `MergedPageConfig` and Harmony's
 * `DMPPageStyle.getBackGroundColor()` fall back to).
 */
export function pageBackgroundColor(config: PageWindowConfig): string {
  return (config.backgroundColor as string | undefined) ?? '#ffffff'
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
