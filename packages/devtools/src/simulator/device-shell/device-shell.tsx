import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SIMULATOR_EVENTS as E } from '../../shared/bridge-channels'
import type {
  NavActionPayload,
  TabActionPayload,
} from '../../shared/bridge-channels'
import type { DeviceShellProps } from './device-shell-types'
import { attachApiCallForwarding } from '../api-call-forwarding'
import { StatusBar } from './status-bar'
import type { NativeDeviceInfo } from '../../shared/ipc-channels'
import { UiOverlay } from './ui-overlay'
import {
  dispatchSimulatorCapsuleMore,
  SimulatorUiExtensionLayer,
} from './simulator-ui-extension-layer'
import {
  applyTabAction,
  enumerateMounted,
  makeInitialShellState,
  makeInitialTabBarState,
  mutatePageNavBar,
  navBarFromConfig,
  NavigationBar,
  normalizePath,
  pageBackgroundColor,
  reduceNavBar,
  shouldShowHomeButton,
  TabBar,
  type PageEntry,
  type SideEffect,
} from '@dimina-kit/electron-runtime/simulator-ui'
import {
  commitShell,
  commitTabBar,
  doNavigateBack,
  doNavigateHome,
  doNavigateTo,
  doReLaunch,
  doRedirectTo,
  doSwitchTab,
  type DeviceShellState,
  type ShellNavPayload,
} from './device-shell-routing'
import './device-shell.css'

export type { DeviceShellProps } from './device-shell-types'

const STATUS_BAR_HEIGHT_IOS = 44
const STATUS_BAR_HEIGHT_ANDROID = 24
const NAV_BAR_HEIGHT = 44

export function DeviceShell(
  { miniApp, bridgeId, platform = 'ios', active = true }: DeviceShellProps,
) {
  const embedded = new URLSearchParams(window.location.search).get('embedded') === '1'
  // The selected device drives the bezel size + status bar height + notch.
  // Initial value rides the native-host bridge config (race-free); live toolbar
  // changes arrive over DEVICE_CHANGE.
  const [device, setDevice] = useState<NativeDeviceInfo | null>(() => miniApp.getInitialDevice())
  useEffect(() => miniApp.onSimulatorEvent<NativeDeviceInfo>(E.DEVICE_CHANGE, setDevice), [miniApp])

  // DeviceShell draws the WHOLE phone at fixed device-logical size on a gray
  // desk that fills the WCV and scrolls when the phone overflows the region.
  // Only the chrome metrics below are derived from the device.
  const statusBarHeight = embedded ? 0 : (device?.safeAreaInsets.top
    ?? (platform === 'ios' ? STATUS_BAR_HEIGHT_IOS : STATUS_BAR_HEIGHT_ANDROID))
  const bottomInset = embedded ? 0 : (device?.safeAreaInsets.bottom ?? 0)
  const notchType = device?.notchType ?? 'none'
  const preload = useMemo(() => miniApp.getRenderPreloadUrl(), [miniApp])
  const tabBarConfig = useMemo(() => miniApp.getTabBarConfig(), [miniApp])

  const initialEntry = useMemo<PageEntry>(() => {
    const pagePath = normalizePath(miniApp.pagePath)
    const windowConfig = miniApp.rootWindowConfig ?? {}
    const isTab = !!miniApp.getTabBarConfig()?.list.some(
      item => normalizePath(item.pagePath) === pagePath,
    )
    return {
      bridgeId,
      pagePath,
      query: { ...miniApp.query },
      isTab,
      windowConfig,
      // The launch page is the stack bottom, so a non-home, non-tab launch
      // page gets the home button by the automatic rule.
      navBar: navBarFromConfig(windowConfig, miniApp.appId, {
        homeButtonVisible: shouldShowHomeButton({
          pagePath,
          homePagePath: miniApp.getHomePagePath(),
          isTab,
          isStackBottom: true,
          forcedByConfig: windowConfig.homeButton === true,
        }),
      }),
    }
  }, [miniApp, bridgeId])

  const [{ shell, tabBar }, setState] = useState<DeviceShellState>(() => ({
    shell: makeInitialShellState(initialEntry),
    tabBar: makeInitialTabBarState(tabBarConfig),
  }))

  // Authoritative state for the bridge-event handlers and the async routing
  // controllers. Written SYNCHRONOUSLY by commitShell/commitTabBar, never by a
  // passive effect: bridge events arrive outside React's batching, so an
  // effect-synced mirror lags one commit behind and would drag this ref back to
  // the pre-event snapshot — the next event then reduces from stale state and
  // overwrites the one before it. React state is only the render mirror.
  const stateRef = useRef<DeviceShellState>({ shell, tabBar })

  const applySideEffects = useCallback((effects: SideEffect[]) => {
    for (const effect of effects) {
      if (effect.kind === 'lifecycle') {
        miniApp.notifyLifecycle(effect.bridgeId, effect.event)
      } else if (effect.kind === 'closePage') {
        miniApp.closePage(effect.bridgeId)
      }
    }
  }, [miniApp])

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
    return miniApp.onSimulatorEvent(E.NAV_BAR, listener)
  }, [miniApp])

  // ── TabBar dynamic API ────────────────────────────────────────────────────
  useEffect(() => {
    const listener = (payload: TabActionPayload) => {
      const next = applyTabAction(stateRef.current.tabBar, {
        kind: 'apply',
        name: payload.name,
        params: payload.params,
      })
      commitTabBar(stateRef, setState, next.state)
      miniApp.notifyNavCallback({
        ok: next.ok,
        errMsg: next.errMsg,
        callbacks: payload.callbacks,
      })
    }
    return miniApp.onSessionEvent(E.TAB_ACTION, listener)
  }, [miniApp])

  // ── Routing controller (navigateTo / Back / redirectTo / reLaunch / switchTab / Home) ─
  // Every routing operation opens its page asynchronously and only then reads
  // `stateRef` to compute the next stack, so two overlapping actions would both
  // decide from the same pre-action snapshot: the loser's freshly-opened page
  // survives in neither the visible stack nor any tab substack and is never
  // closed. Actions therefore run one at a time — a tail-chained promise is the
  // single gate every entry point (service NAV_ACTION and the nav-bar buttons)
  // goes through. A failing action never blocks the next one.
  const navQueueRef = useRef<Promise<void>>(Promise.resolve())
  // Monotonic stamp that retires the whole queue when this shell goes away. A
  // queued action can still be waiting on its PAGE_OPEN when a soft reload
  // swaps in a new shell and disposes this session; resuming it afterwards
  // would commit into an unmounted tree and reduce from a stack nobody owns.
  // Each action captures the stamp and re-checks it after every await.
  const navEpochRef = useRef(0)
  useEffect(() => () => { navEpochRef.current += 1 }, [])

  const runNavAction = useCallback(
    async (payload: ShellNavPayload) => {
      const ack = (ok: boolean, errMsg: string): void =>
        miniApp.notifyNavCallback({ ok, errMsg, callbacks: payload.callbacks })

      try {
        switch (payload.name) {
          case 'navigateTo':
            await doNavigateTo(miniApp, stateRef, setState, applySideEffects, payload, ack)
            break
          case 'navigateBack':
            doNavigateBack(stateRef, setState, applySideEffects, payload, ack)
            break
          case 'redirectTo':
            await doRedirectTo(miniApp, stateRef, setState, applySideEffects, payload, ack)
            break
          case 'reLaunch':
            await doReLaunch(miniApp, stateRef, setState, applySideEffects, payload, ack)
            break
          case 'switchTab':
            await doSwitchTab(miniApp, stateRef, setState, applySideEffects, payload, ack)
            break
          case 'navigateHome':
            await doNavigateHome(miniApp, stateRef, setState, applySideEffects, payload, ack)
            break
        }
      } catch (err) {
        ack(false, `${payload.name}:fail ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [miniApp, applySideEffects],
  )

  const performNavAction = useCallback(
    (payload: ShellNavPayload): Promise<void> => {
      const epoch = navEpochRef.current
      const queued = navQueueRef.current.then(() => {
        // Retired while this one waited its turn — the shell it would act on is
        // gone. An action already past this point when the shell went away
        // still finishes, but every outbound call it makes is dropped by
        // SimulatorMiniApp's own cleared-session guards.
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
    return miniApp.onSessionEvent(E.NAV_ACTION, listener)
  }, [performNavAction, miniApp])

  // ── invokeAPI fallback (main → simulator) — see api-call-forwarding.ts ─────
  useEffect(() => attachApiCallForwarding(miniApp), [miniApp])

  // ── Click handlers (back arrow + tab item) ────────────────────────────────
  const handleBack = useCallback(() => {
    if (stateRef.current.shell.stack.length <= 1) return
    const stack = stateRef.current.shell.stack
    void performNavAction({
      appSessionId: miniApp.appSessionId ?? '',
      bridgeId: stack[stack.length - 1].bridgeId,
      name: 'navigateBack',
      params: { delta: 1 },
      callbacks: {},
    })
  }, [miniApp, performNavAction])

  // The home button only dispatches; `navigateHome` (device-shell-routing) is
  // the single authority that picks the routing verb, mirroring each native
  // platform's navigateHome primitive.
  const handleHome = useCallback(() => {
    const stack = stateRef.current.shell.stack
    void performNavAction({
      appSessionId: miniApp.appSessionId ?? '',
      bridgeId: stack[stack.length - 1].bridgeId,
      name: 'navigateHome',
      params: {},
      callbacks: {},
    })
  }, [miniApp, performNavAction])

  const handleTabClick = useCallback((pagePath: string) => {
    const sh = stateRef.current.shell
    if (pagePath === sh.currentTabPath && sh.stack.length === 1) return
    void performNavAction({
      appSessionId: miniApp.appSessionId ?? '',
      bridgeId: sh.stack[sh.stack.length - 1].bridgeId,
      name: 'switchTab',
      params: { url: `/${pagePath}` },
      callbacks: {},
    })
  }, [miniApp, performNavAction])

  // ── Rendering ─────────────────────────────────────────────────────────────
  const top = shell.stack[shell.stack.length - 1]
  const mounted = enumerateMounted(shell)
  const handleMore = useCallback(() => {
    dispatchSimulatorCapsuleMore(miniApp.appId, top.navBar.title, top.pagePath)
  }, [miniApp.appId, top.navBar.title, top.pagePath])

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
    miniApp.notifyPageStack(shell.stack.map((e) => ({ pagePath: e.pagePath, query: e.query })))
  }, [miniApp, shell.stack])

  // Tell main which page is the visible top-of-stack so main-side panels
  // (WXML/element-inspect) and automation can target the active render
  // webContents — main has no z-order concept of its own. Fires on every
  // top change (navigate / back / switchTab).
  useEffect(() => {
    miniApp.notifyActivePage(top.bridgeId)
  }, [miniApp, top.bridgeId])

  return (
    <main className={`device-shell-root${embedded ? ' device-shell-root--embedded' : ''}`}>
      <section
        className={`device-shell${embedded ? ' device-shell--embedded' : ''}`}
        aria-label="Dimina simulator"
        // Fixed device-logical size so the phone never squishes with the
        // window/flex: the desk (.device-shell-root) scrolls when it overflows.
        // Omitted when device is null → CSS sizing fallback fills the desk.
        style={!embedded && device
          ? { width: device.screenWidth, height: device.screenHeight }
          : undefined}
      >
        {/*
          Status bar overlay (time / icons / notch) pinned to the device top,
          above both the nav-bar and the page webview. The nav-bar still reserves
          `statusBarHeight` below it (paddingTop), so default nav blends its bg
          up into the status area while custom nav shows the page through it.
        */}
        {!embedded && (
          <StatusBar
            height={statusBarHeight}
            notchType={notchType}
            textStyle={top.navBar.textStyle}
          />
        )}
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
              src={miniApp.createRenderHostUrl(entry.bridgeId, entry.pagePath, entry.isTab, pageBackgroundColor(entry.windowConfig))}
              preload={preload}
              // No static partition here: the renderer doesn't know the
              // per-project partition — the host WCV's `will-attach-webview`
              // handler (view-manager.ts) stamps every render-host guest onto
              // this project's `persist:miniapp-<key>` partition instead.
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
            resourceBaseUrl={miniApp.resourceBaseUrl}
            appId={miniApp.appId}
            onSwitch={handleTabClick}
            // WeChat parity: the tabBar background extends through the bottom
            // safe area so the home-indicator strip is the tabBar's color.
            bottomInset={bottomInset}
          />
        )}
        {/* Native interaction overlays (toast / loading / modal / action
            sheet). Last in flow so it layers above the page webview + tabBar,
            clipped to the device bezel. */}
        <UiOverlay />
        <SimulatorUiExtensionLayer active={active} appId={miniApp.appId} />
        {/* Home-indicator pill — an absolute overlay at the device bottom
            (gesture-bar devices only; the home-button SE class has bottom inset
            0). It is NOT in flow: a tab page sees the tabBar's color behind it,
            a non-tab page is full-bleed so its own content shows through. The
            page reserves bottom space only via its own env(safe-area-inset-*). */}
        {bottomInset > 0 && (
          <div
            className="device-shell__home-indicator"
            style={{ height: bottomInset }}
            aria-hidden="true"
          />
        )}
      </section>
    </main>
  )
}
