import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SIMULATOR_EVENTS as E } from '../../shared/bridge-channels'
import type {
  ApiCallPayload,
  NavActionPayload,
  TabActionPayload,
} from '../../shared/bridge-channels'
import type { SimulatorMiniApp } from '../simulator-mini-app'
import { runApiAsync } from '../run-api-async'
import {
  NavigationBar,
  type NavBarPlatform,
} from './navigation-bar'
import { StatusBar } from './status-bar'
import type { NativeDeviceInfo } from '../../shared/ipc-channels'
import { TabBar } from './tab-bar'
import {
  applyTabAction,
  makeInitialTabBarState,
  type TabBarState,
} from './tab-bar-state'
import {
  enumerateMounted,
  makeInitialShellState,
  mutatePageNavBar,
  navBarFromConfig,
  normalizePath,
  parseUrl,
  reduceNavBar,
  reduceNavigateBack,
  reduceNavigateTo,
  reduceReLaunch,
  reduceRedirectTo,
  reduceSwitchTab,
  type PageEntry,
  type ShellState,
  type SideEffect,
} from './page-stack-controller'
import './device-shell.css'

export interface DeviceShellProps {
  miniApp: SimulatorMiniApp
  bridgeId: string
  width?: number
  height?: number
  /**
   * Which platform's NavigationBar conventions to emulate.
   * iOS: title centered, status bar height 44.
   * Android: title left-aligned, status bar height varies.
   */
  platform?: NavBarPlatform
}

const STATUS_BAR_HEIGHT_IOS = 44
const STATUS_BAR_HEIGHT_ANDROID = 24
const NAV_BAR_HEIGHT = 44

interface DeviceShellState {
  shell: ShellState
  tabBar: TabBarState
}

export function DeviceShell({
  miniApp,
  bridgeId,
  platform = 'ios',
}: DeviceShellProps) {
  // The selected device drives the bezel size + status bar height + notch.
  // Initial value rides the native-host bridge config (race-free); live toolbar
  // changes arrive over DEVICE_CHANGE.
  const [device, setDevice] = useState<NativeDeviceInfo | null>(() => miniApp.getInitialDevice())
  useEffect(() => miniApp.onSimulatorEvent<NativeDeviceInfo>(E.DEVICE_CHANGE, setDevice), [miniApp])

  // DeviceShell draws the WHOLE phone at fixed device-logical size on a gray
  // desk that fills the WCV and scrolls when the phone overflows the region.
  // Only the chrome metrics below are derived from the device.
  const statusBarHeight = device?.safeAreaInsets.top
    ?? (platform === 'ios' ? STATUS_BAR_HEIGHT_IOS : STATUS_BAR_HEIGHT_ANDROID)
  const bottomInset = device?.safeAreaInsets.bottom ?? 0
  const notchType = device?.notchType ?? 'none'
  const preload = useMemo(() => miniApp.getRenderPreloadUrl(), [miniApp])
  const tabBarConfig = useMemo(() => miniApp.getTabBarConfig(), [miniApp])

  const initialEntry = useMemo<PageEntry>(() => ({
    bridgeId,
    pagePath: normalizePath(miniApp.pagePath),
    query: { ...miniApp.query },
    isTab: !!miniApp.getTabBarConfig()?.list.some(
      item => normalizePath(item.pagePath) === normalizePath(miniApp.pagePath),
    ),
    windowConfig: miniApp.rootWindowConfig ?? {},
    navBar: navBarFromConfig(miniApp.rootWindowConfig ?? {}, miniApp.appId),
  }), [miniApp, bridgeId])

  const [{ shell, tabBar }, setState] = useState<DeviceShellState>(() => ({
    shell: makeInitialShellState(initialEntry),
    tabBar: makeInitialTabBarState(tabBarConfig),
  }))

  // Ref mirror of state so async controllers can read current value without
  // closing over a stale snapshot.
  const stateRef = useRef<DeviceShellState>({ shell, tabBar })
  useEffect(() => { stateRef.current = { shell, tabBar } }, [shell, tabBar])

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
      setState(prev => ({
        ...prev,
        shell: mutatePageNavBar(prev.shell, payload.bridgeId, navBar =>
          reduceNavBar(navBar, payload.name, payload.params),
        ),
      }))
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
      setState(prev => ({ ...prev, tabBar: next.state }))
      miniApp.notifyNavCallback({
        ok: next.ok,
        errMsg: next.errMsg,
        callbacks: payload.callbacks,
      })
    }
    return miniApp.onSimulatorEvent(E.TAB_ACTION, listener)
  }, [miniApp])

  // ── Routing controller (navigateTo / Back / redirectTo / reLaunch / switchTab) ─
  const performNavAction = useCallback(
    async (payload: NavActionPayload) => {
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
        }
      } catch (err) {
        ack(false, `${payload.name}:fail ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [miniApp, applySideEffects],
  )

  useEffect(() => {
    const listener = (payload: NavActionPayload) => {
      void performNavAction(payload)
    }
    return miniApp.onSimulatorEvent(E.NAV_ACTION, listener)
  }, [performNavAction, miniApp])

  // ── invokeAPI fallback (main → simulator) ──────────────────────────────────
  // Main forwards any invokeAPI name that is not registered in its
  // ctx.simulatorApis registry to us. The simulator-resident MiniApp owns the
  // wx.* handler (it can read DOM, open file pickers, …); we run it via
  // runApiAsync (which captures the handler's success/fail callback) and
  // echo the verdict back so main can fire the original service-side
  // callbacks against their service-host ids.
  useEffect(() => {
    const listener = (payload: ApiCallPayload) => {
      // `emit` fires once for one-shot APIs and on every subsequent success
      // for persistent (`keep: true`) subscriptions like audioListen, so each
      // container audio event reaches the service-side dispatcher.
      void runApiAsync(miniApp, payload.name, payload.params, (verdict) => {
        miniApp.notifyApiResponse({
          requestId: payload.requestId,
          ok: verdict.ok,
          result: verdict.result,
          errMsg: verdict.errMsg,
          keep: verdict.keep,
        })
      })
    }
    return miniApp.onSimulatorEvent(E.API_CALL, listener)
  }, [miniApp])

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

  // Tell main which page is the visible top-of-stack so main-side panels
  // (WXML/element-inspect) and automation can target the active render
  // webContents — main has no z-order concept of its own. Fires on every
  // top change (navigate / back / switchTab).
  useEffect(() => {
    miniApp.notifyActivePage(top.bridgeId)
  }, [miniApp, top.bridgeId])

  // Report the full ordered stack (bottom→top) on every stack change so
  // automation's App.getPageStack can return a multi-page stack — main only
  // tracks the active bridgeId on its own.
  useEffect(() => {
    miniApp.notifyPageStack(shell.stack.map((e) => ({ pagePath: e.pagePath, query: e.query })))
  }, [miniApp, shell.stack])

  return (
    <main className="device-shell-root">
      <section
        className="device-shell"
        aria-label="Dimina simulator"
        // Fixed device-logical size so the phone never squishes with the
        // window/flex: the desk (.device-shell-root) scrolls when it overflows.
        // Omitted when device is null → CSS sizing fallback fills the desk.
        style={device ? { width: device.screenWidth, height: device.screenHeight } : undefined}
      >
        {/*
          Status bar overlay (time / icons / notch) pinned to the device top,
          above both the nav-bar and the page webview. The nav-bar still reserves
          `statusBarHeight` below it (paddingTop), so default nav blends its bg
          up into the status area while custom nav shows the page through it.
        */}
        <StatusBar
          height={statusBarHeight}
          notchType={notchType}
          textStyle={top.navBar.textStyle}
        />
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
        />
        <div className="device-shell__viewport">
          {mounted.map(({ entry, visible }) => (
            <webview
              key={entry.bridgeId}
              className="device-shell__webview"
              src={miniApp.createRenderHostUrl(entry.bridgeId, entry.pagePath)}
              preload={preload}
              // No static partition here: the renderer doesn't know the
              // per-project partition. Main owns it — the host WCV's
              // `will-attach-webview` handler (view-manager.ts) stamps every
              // render-host guest onto this project's `persist:miniapp-<key>`
              // partition. Hardcoding `persist:simulator` here would request the
              // shared session pre-attach and defeat per-project isolation.
              allowpopups="true"
              style={{
                display: visible ? 'flex' : 'none',
                zIndex: visible ? 100 : 1,
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
          />
        )}
        {/* Home-indicator strip sized to the device bottom inset (gesture-bar
            devices only; the home-button SE class has bottom inset 0). */}
        {bottomInset > 0 && (
          <div
            className="device-shell__home-indicator"
            style={{ flexBasis: bottomInset }}
            aria-hidden="true"
          />
        )}
      </section>
    </main>
  )
}

// ─── Routing operations ─────────────────────────────────────────────────────

type StateRef = React.MutableRefObject<DeviceShellState>
type SetState = React.Dispatch<React.SetStateAction<DeviceShellState>>
type Ack = (ok: boolean, errMsg: string) => void

async function doNavigateTo(
  miniApp: SimulatorMiniApp,
  ref: StateRef,
  setState: SetState,
  applySideEffects: (effects: SideEffect[]) => void,
  payload: NavActionPayload,
  ack: Ack,
): Promise<void> {
  const { pagePath, query } = parseUrl(payload.params.url)
  if (!pagePath) {
    ack(false, 'navigateTo:fail invalid url')
    return
  }
  if (miniApp.getTabBarConfig()?.list.some(item => normalizePath(item.pagePath) === pagePath)) {
    ack(false, 'navigateTo:fail can not navigateTo a tabbar page')
    return
  }

  const opened = await miniApp.openPage(pagePath, query)
  const newEntry: PageEntry = {
    bridgeId: opened.bridgeId,
    pagePath: opened.pagePath,
    query,
    isTab: opened.isTab,
    windowConfig: opened.windowConfig,
    navBar: navBarFromConfig(opened.windowConfig, miniApp.appId),
  }
  const { next, effects } = reduceNavigateTo(ref.current.shell, newEntry)
  setState(prev => ({ ...prev, shell: next }))
  applySideEffects(effects)
  ack(true, 'navigateTo:ok')
}

function doNavigateBack(
  ref: StateRef,
  setState: SetState,
  applySideEffects: (effects: SideEffect[]) => void,
  payload: NavActionPayload,
  ack: Ack,
): void {
  const rawDelta = payload.params.delta
  const delta = Number.isFinite(Number(rawDelta)) ? Number(rawDelta) : 1
  const result = reduceNavigateBack(ref.current.shell, delta)
  if ('error' in result) {
    ack(false, `navigateBack:fail ${result.error}`)
    return
  }
  setState(prev => ({ ...prev, shell: result.next }))
  applySideEffects(result.effects)
  ack(true, 'navigateBack:ok')
}

async function doRedirectTo(
  miniApp: SimulatorMiniApp,
  ref: StateRef,
  setState: SetState,
  applySideEffects: (effects: SideEffect[]) => void,
  payload: NavActionPayload,
  ack: Ack,
): Promise<void> {
  const { pagePath, query } = parseUrl(payload.params.url)
  if (!pagePath) {
    ack(false, 'redirectTo:fail invalid url')
    return
  }
  if (miniApp.getTabBarConfig()?.list.some(item => normalizePath(item.pagePath) === pagePath)) {
    ack(false, 'redirectTo:fail can not redirectTo a tabbar page')
    return
  }
  const opened = await miniApp.openPage(pagePath, query)
  const newEntry: PageEntry = {
    bridgeId: opened.bridgeId,
    pagePath: opened.pagePath,
    query,
    isTab: opened.isTab,
    windowConfig: opened.windowConfig,
    navBar: navBarFromConfig(opened.windowConfig, miniApp.appId),
  }
  const { next, effects } = reduceRedirectTo(ref.current.shell, newEntry)
  setState(prev => ({ ...prev, shell: next }))
  applySideEffects(effects)
  ack(true, 'redirectTo:ok')
}

async function doReLaunch(
  miniApp: SimulatorMiniApp,
  ref: StateRef,
  setState: SetState,
  applySideEffects: (effects: SideEffect[]) => void,
  payload: NavActionPayload,
  ack: Ack,
): Promise<void> {
  const { pagePath, query } = parseUrl(payload.params.url)
  if (!pagePath) {
    ack(false, 'reLaunch:fail invalid url')
    return
  }
  const opened = await miniApp.openPage(pagePath, query)
  const newEntry: PageEntry = {
    bridgeId: opened.bridgeId,
    pagePath: opened.pagePath,
    query,
    isTab: opened.isTab,
    windowConfig: opened.windowConfig,
    navBar: navBarFromConfig(opened.windowConfig, miniApp.appId),
  }
  const { next, effects } = reduceReLaunch(ref.current.shell, newEntry)
  setState(prev => ({ ...prev, shell: next }))
  applySideEffects(effects)
  ack(true, 'reLaunch:ok')
}

async function doSwitchTab(
  miniApp: SimulatorMiniApp,
  ref: StateRef,
  setState: SetState,
  applySideEffects: (effects: SideEffect[]) => void,
  payload: NavActionPayload,
  ack: Ack,
): Promise<void> {
  const { pagePath } = parseUrl(payload.params.url)
  if (!pagePath) {
    ack(false, 'switchTab:fail invalid url')
    return
  }
  if (!miniApp.getTabBarConfig()?.list.some(item => normalizePath(item.pagePath) === pagePath)) {
    ack(false, `switchTab:fail not a tabBar page: ${pagePath}`)
    return
  }

  const before = ref.current.shell
  const cached = before.tabStacks[pagePath]
  let freshEntry: PageEntry | null = null
  if (!cached || cached.length === 0) {
    const opened = await miniApp.openPage(pagePath, {})
    freshEntry = {
      bridgeId: opened.bridgeId,
      pagePath: opened.pagePath,
      query: {},
      isTab: true,
      windowConfig: opened.windowConfig,
      navBar: navBarFromConfig(opened.windowConfig, miniApp.appId),
    }
  }

  const { next, effects } = reduceSwitchTab(ref.current.shell, pagePath, freshEntry)
  setState(prev => ({ ...prev, shell: next }))
  applySideEffects(effects)
  ack(true, 'switchTab:ok')
}
