/**
 * The mini-app itself: navigation bar, the page stack rendered as render-host
 * guests, the tabBar, and the native interaction overlays — plus the routing
 * queue and state machines that drive them.
 *
 * Everything device-shaped is the host's: bezel, notch, status bar, home
 * indicator and screen geometry never appear here. What the frame needs of them
 * arrives as two numbers (`statusBarHeight`, `bottomInset`) and two slots the
 * host fills with its own chrome, so the same mini-app renders identically
 * whether it is installed into a simulated phone, a plain window, or a host app
 * with no device pretense at all.
 *
 * Renders a fragment rather than a container of its own: the host owns the box
 * these children lay out in (its size, corners and clipping ARE the device), so
 * imposing a wrapper here would only fight it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { SIMULATOR_EVENTS as E } from '../shared/bridge-channels.js'
import type {
  NavActionPayload,
  TabActionPayload,
} from '../shared/bridge-channels.js'
import type { MiniAppHost } from './miniapp-host.js'
import { NavigationBar } from './navigation-bar.js'
import type { NavBarPlatform, NavigationBarTextStyle } from './navigation-bar.js'
import { TabBar } from './tab-bar.js'
import { UiOverlay } from './ui-overlay.js'
import { applyTabAction, makeInitialTabBarState } from './tab-bar-state.js'
import {
  enumerateMounted,
  makeInitialShellState,
  mutatePageNavBar,
  pageBackgroundColor,
  type PageEntry,
  type SideEffect,
} from './page-stack-controller.js'
import { reduceNavBar } from './navigation-bar-config.js'
import {
  commitShell,
  commitTabBar,
  doNavigateBack,
  doNavigateHome,
  doNavigateTo,
  doReLaunch,
  doRedirectTo,
  doSwitchTab,
  makeLaunchPageEntry,
  type MiniAppFrameState,
  type ShellNavPayload,
} from './miniapp-routing.js'
import './miniapp-frame.css'

const NAV_BAR_HEIGHT = 44

/** What the capsule's "more" button hands the host when there is nothing built in to do. */
export interface CapsuleMoreContext {
  appId: string
  /** The active page's title, falling back to the appId when it has none. */
  appName: string
  pagePath: string
}

/**
 * Page chrome state the host's own overlays need. A status bar drawn over the
 * mini-app has to follow the active page's `navigationBarTextStyle` — white
 * glyphs over a dark page, black over a light one — and only the frame knows
 * which page is active.
 */
export interface FrameChromeState {
  textStyle: NavigationBarTextStyle
}

export interface MiniAppFrameLayoutState {
  top: PageEntry
  mounted: ReturnType<typeof enumerateMounted>
  tabBarVisible: boolean
}

export interface MiniAppFrameProps {
  host: MiniAppHost
  /** The bridgeId of the page the host already spawned — the stack bottom. */
  bridgeId: string
  /** Whose navigation-bar conventions to follow (title centered vs leading). */
  platform?: NavBarPlatform
  /**
   * Chrome height the host reserves above the mini-app. The nav bar pads itself
   * by this much so a default bar blends its background up into that strip and
   * a custom bar shows the page through it. 0 when the host draws no status bar.
   */
  statusBarHeight?: number
  /**
   * Bottom safe area. The tabBar's background extends through it (WeChat /
   * Android / Harmony parity) so the home-indicator strip takes the tabBar's
   * color. 0 when the host has no bottom inset.
   */
  bottomInset?: number
  /** Capsule "more" handler. Without one the button still renders but does nothing. */
  onMore?: (context: CapsuleMoreContext) => void
  /**
   * Host chrome drawn above the nav bar — a status bar, a notch. A function so
   * it can follow the active page's chrome state; see `FrameChromeState`.
   */
  statusBar?: (chrome: FrameChromeState) => ReactNode
  /** Host chrome drawn above everything — extension layers, a home indicator. */
  deviceOverlay?: ReactNode
  /** Host-owned geometry authority can observe the committed page/layout state. */
  onLayoutState?: (state: MiniAppFrameLayoutState) => void
  /** Publishes geometry synchronously before a tab-bar API is acknowledged. */
  onLayoutCommit?: (state: MiniAppFrameLayoutState) => void
}

export function MiniAppFrame({
  host,
  bridgeId,
  platform = 'ios',
  statusBarHeight = 0,
  bottomInset = 0,
  onMore,
  statusBar,
  deviceOverlay,
  onLayoutState,
  onLayoutCommit,
}: MiniAppFrameProps) {
  const preload = useMemo(() => host.getRenderPreloadUrl(), [host])
  const tabBarConfig = useMemo(() => host.getTabBarConfig(), [host])

  const initialEntry = useMemo<PageEntry>(
    () => makeLaunchPageEntry(host, bridgeId),
    [host, bridgeId],
  )

  const [{ shell, tabBar }, setState] = useState<MiniAppFrameState>(() => ({
    shell: makeInitialShellState(initialEntry),
    tabBar: makeInitialTabBarState(tabBarConfig),
  }))

  // Authoritative state for the bridge-event handlers and the async routing
  // controllers. Written SYNCHRONOUSLY by commitShell/commitTabBar, never by a
  // passive effect: bridge events arrive outside React's batching, so an
  // effect-synced mirror lags one commit behind and would drag this ref back to
  // the pre-event snapshot — the next event then reduces from stale state and
  // overwrites the one before it. React state is only the render mirror.
  const stateRef = useRef<MiniAppFrameState>({ shell, tabBar })

  const applySideEffects = useCallback((effects: SideEffect[]) => {
    // 几何要先于 pageShow 到达主进程：模拟器里 `getSystemInfoSync` 读的是主进程缓存的 hostEnv 快照，`onShow` 里同步读到的必须已经是落地页自己的尺寸。
    // 三端 native 不需要这一步，它们的同步接口每次都现读窗口。
    //
    // 这条上报因此排在 pageShow 之前，而 service 的 pageResize 不能因为「这一页还没 show」就把它丢掉——收件人在 16ms 合并窗结算时才定，那时 pageShow 早已送达（见 fe/packages/service/src/core/runtime.js 的 pageResize/settleResize）。
    const currentShell = stateRef.current.shell
    onLayoutCommit?.({
      top: currentShell.stack[currentShell.stack.length - 1],
      mounted: enumerateMounted(currentShell),
      tabBarVisible: stateRef.current.tabBar.visible,
    })
    for (const effect of effects) {
      if (effect.kind === 'lifecycle') {
        host.notifyLifecycle(effect.bridgeId, effect.event)
      } else if (effect.kind === 'closePage') {
        host.closePage(effect.bridgeId)
      }
    }
  }, [host, onLayoutCommit])

  // ── NavigationBar dynamic updates ──────────────────────────────────────────
  useEffect(() => {
    const listener = (
      payload: { bridgeId: string; name: string; params: Record<string, unknown> },
    ) => {
      commitShell(
        stateRef,
        setState,
        mutatePageNavBar(stateRef.current.shell, payload.bridgeId, navBar =>
          reduceNavBar(navBar, payload.name, payload.params),
        ),
      )
    }
    return host.onSimulatorEvent(E.NAV_BAR, listener)
  }, [host])

  // ── TabBar dynamic API ────────────────────────────────────────────────────
  useEffect(() => {
    const listener = (payload: TabActionPayload) => {
      const previous = stateRef.current.tabBar
      const next = applyTabAction(previous, {
        kind: 'apply',
        name: payload.name,
        params: payload.params,
      })
      commitTabBar(stateRef, setState, next.state)
      if (previous.visible !== next.state.visible) {
        const currentShell = stateRef.current.shell
        onLayoutCommit?.({
          top: currentShell.stack[currentShell.stack.length - 1],
          mounted: enumerateMounted(currentShell),
          tabBarVisible: next.state.visible,
        })
      }
      host.notifyNavCallback({
        ok: next.ok,
        errMsg: next.errMsg,
        callbacks: payload.callbacks,
      })
    }
    return host.onSessionEvent(E.TAB_ACTION, listener)
  }, [host, onLayoutCommit])

  // ── Routing controller (navigateTo / Back / redirectTo / reLaunch / switchTab / Home) ─
  // Every routing operation opens its page asynchronously and only then reads
  // `stateRef` to compute the next stack, so two overlapping actions would both
  // decide from the same pre-action snapshot: the loser's freshly-opened page
  // survives in neither the visible stack nor any tab substack and is never
  // closed. Actions therefore run one at a time — a tail-chained promise is the
  // single gate every entry point (service NAV_ACTION and the nav-bar buttons)
  // goes through. A failing action never blocks the next one.
  const navQueueRef = useRef<Promise<void>>(Promise.resolve())
  // Monotonic stamp that retires the whole queue when this frame goes away. A
  // queued action can still be waiting on its PAGE_OPEN when a soft reload
  // swaps in a new frame and disposes this session; resuming it afterwards
  // would commit into an unmounted tree and reduce from a stack nobody owns.
  // Each action captures the stamp and re-checks it after every await.
  const navEpochRef = useRef(0)
  useEffect(() => () => { navEpochRef.current += 1 }, [])

  const runNavAction = useCallback(
    async (payload: ShellNavPayload) => {
      const ack = (ok: boolean, errMsg: string): void =>
        host.notifyNavCallback({ ok, errMsg, callbacks: payload.callbacks })

      try {
        switch (payload.name) {
          case 'navigateTo':
            await doNavigateTo(host, stateRef, setState, applySideEffects, payload, ack)
            break
          case 'navigateBack':
            doNavigateBack(stateRef, setState, applySideEffects, payload, ack)
            break
          case 'redirectTo':
            await doRedirectTo(host, stateRef, setState, applySideEffects, payload, ack)
            break
          case 'reLaunch':
            await doReLaunch(host, stateRef, setState, applySideEffects, payload, ack)
            break
          case 'switchTab':
            await doSwitchTab(host, stateRef, setState, applySideEffects, payload, ack)
            break
          case 'navigateHome':
            await doNavigateHome(host, stateRef, setState, applySideEffects, payload, ack)
            break
        }
      } catch (err) {
        ack(false, `${payload.name}:fail ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [host, applySideEffects],
  )

  const performNavAction = useCallback(
    (payload: ShellNavPayload): Promise<void> => {
      const epoch = navEpochRef.current
      const queued = navQueueRef.current.then(() => {
        // Retired while this one waited its turn — the frame it would act on is
        // gone. An action already past this point when the frame went away
        // still finishes, but every outbound call it makes is dropped by the
        // host's own cleared-session guards.
        if (navEpochRef.current !== epoch) return
        return runNavAction(payload)
      })
      navQueueRef.current = queued.catch(() => {})
      return queued
    },
    [runNavAction],
  )

  useEffect(() => {
    const listener = (payload: NavActionPayload) => {
      void performNavAction(payload)
    }
    return host.onSessionEvent(E.NAV_ACTION, listener)
  }, [performNavAction, host])

  // ── Click handlers (back arrow + tab item) ────────────────────────────────
  const handleBack = useCallback(() => {
    if (stateRef.current.shell.stack.length <= 1) return
    const stack = stateRef.current.shell.stack
    void performNavAction({
      appSessionId: host.appSessionId ?? '',
      bridgeId: stack[stack.length - 1].bridgeId,
      name: 'navigateBack',
      params: { delta: 1 },
      callbacks: {},
    })
  }, [host, performNavAction])

  // The home button only dispatches; `navigateHome` (miniapp-routing) is the
  // single authority that picks the routing verb, mirroring each native
  // platform's navigateHome primitive.
  const handleHome = useCallback(() => {
    const stack = stateRef.current.shell.stack
    void performNavAction({
      appSessionId: host.appSessionId ?? '',
      bridgeId: stack[stack.length - 1].bridgeId,
      name: 'navigateHome',
      params: {},
      callbacks: {},
    })
  }, [host, performNavAction])

  const handleTabClick = useCallback((pagePath: string) => {
    const sh = stateRef.current.shell
    if (pagePath === sh.currentTabPath && sh.stack.length === 1) return
    void performNavAction({
      appSessionId: host.appSessionId ?? '',
      bridgeId: sh.stack[sh.stack.length - 1].bridgeId,
      name: 'switchTab',
      params: { url: `/${pagePath}` },
      callbacks: {},
    })
  }, [host, performNavAction])

  // ── Rendering ─────────────────────────────────────────────────────────────
  const top = shell.stack[shell.stack.length - 1]
  const mounted = enumerateMounted(shell)
  useEffect(() => {
    onLayoutState?.({ top, mounted, tabBarVisible: tabBar.visible })
  }, [mounted, onLayoutState, tabBar.visible, top])
  const handleMore = useCallback(() => {
    onMore?.({
      appId: host.appId,
      appName: top.navBar.title || host.appId,
      pagePath: top.pagePath,
    })
  }, [onMore, host, top.navBar.title, top.pagePath])

  // Report the full ordered stack (bottom→top) on every stack change so
  // automation's App.getPageStack can return a multi-page stack — main only
  // tracks the active bridgeId on its own.
  //
  // Declared BEFORE the active-page report on purpose, and the two must stay in
  // this order: ACTIVE_PAGE is what releases automation's wait-for-navigation,
  // and main drops its stored stack the moment a page closes, so an active-page
  // signal arriving first lets App.getPageStack answer from its single-page
  // fallback while the real stack is still in flight. A top change always comes
  // with a new stack array (`top` is derived from it), so both effects run in
  // the same commit and React fires them in declaration order.
  useEffect(() => {
    host.notifyPageStack(shell.stack.map((e) => ({ pagePath: e.pagePath, query: e.query })))
  }, [host, shell.stack])

  // Tell main which page is the visible top-of-stack so main-side panels
  // (WXML/element-inspect) and automation can target the active render
  // webContents — main has no z-order concept of its own. Fires on every
  // top change (navigate / back / switchTab).
  useEffect(() => {
    host.notifyActivePage(top.bridgeId)
  }, [host, top.bridgeId])

  // The launch page is the one page no routing reduction ever installs, so it is also the one page nothing else would announce as visible — every other top gets its pageShow from the reducers (see showTop in page-stack-controller).
  // Declared after the layout effects above so the page's geometry is published before its onShow runs, same order routing transitions get from applySideEffects.
  useEffect(() => {
    host.notifyLifecycle(initialEntry.bridgeId, 'pageShow')
  }, [host, initialEntry.bridgeId])

  return (
    <>
      {statusBar?.({ textStyle: top.navBar.textStyle })}
      {/*
        Default nav-bar is in-flow (reserves its own height); custom nav-bar
        is an absolute overlay and the webview renders full-bleed beneath it.
        So the viewport needs no nav-height padding — see navigation-bar.css.
      */}
      <NavigationBar
        state={top.navBar}
        stackDepth={shell.stack.length}
        platform={platform}
        statusBarHeight={statusBarHeight}
        navBarHeight={NAV_BAR_HEIGHT}
        onBack={handleBack}
        onHome={handleHome}
        onMore={handleMore}
      />
      <div className="device-shell__viewport">
        {mounted.map(({ entry, visible }) => (
          <webview
            key={entry.bridgeId}
            className="device-shell__webview"
            src={host.createRenderHostUrl(entry.bridgeId, entry.pagePath, entry.isTab, pageBackgroundColor(entry.windowConfig))}
            preload={preload}
            // No static partition here: the renderer doesn't know the
            // per-project partition — the host WCV's `will-attach-webview`
            // handler stamps every render-host guest onto this project's
            // `persist:miniapp-<key>` partition instead.
            allowpopups="true"
            style={{
              display: visible ? 'flex' : 'none',
              zIndex: visible ? 100 : 1,
              // White-flash fix (WeChat/Android/Harmony parity): host-painted primer.
              backgroundColor: pageBackgroundColor(entry.windowConfig),
            }}
          />
        ))}
      </div>
      {top.isTab && (
        <TabBar
          state={tabBar}
          currentPath={shell.currentTabPath}
          resourceBaseUrl={host.resourceBaseUrl}
          appId={host.appId}
          onSwitch={handleTabClick}
          bottomInset={bottomInset}
        />
      )}
      {/* Native interaction overlays (toast / loading / modal / action sheet).
          After the page and tabBar so it layers above both. */}
      <UiOverlay />
      {deviceOverlay}
    </>
  )
}
