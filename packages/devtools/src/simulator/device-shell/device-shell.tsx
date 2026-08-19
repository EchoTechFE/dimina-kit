/**
 * The simulated device owns physical geometry and orientation.
 * MiniAppFrame owns navigation; its committed layout snapshot is the only input this host uses to publish page window geometry.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SIMULATOR_EVENTS as E } from '../../shared/bridge-channels'
import type { DeviceShellProps } from './device-shell-types'
import { attachApiCallForwarding } from '../api-call-forwarding'
import { StatusBar } from './status-bar'
import type { NativeDeviceInfo } from '../../shared/ipc-channels'
import {
  dispatchSimulatorCapsuleMore,
  SimulatorUiExtensionLayer,
} from './simulator-ui-extension-layer'
import {
  MiniAppFrame,
  makeLaunchPageEntry,
  type CapsuleMoreContext,
  type MiniAppFrameLayoutState,
} from '@dimina-kit/electron-runtime/simulator-ui'
import { useOrientation } from './use-orientation'
import './device-shell.css'

export type { DeviceShellProps } from './device-shell-types'

const STATUS_BAR_HEIGHT_IOS = 44
const STATUS_BAR_HEIGHT_ANDROID = 24

/**
 * Mirror of the layout MiniAppFrame starts with, for the render pass before its first layout callback arrives.
 * The launch page comes from the frame's own builder rather than a second hand-written literal: this seed feeds the first geometry publish, and a launch page declaring `navigationStyle: "custom"` would otherwise be published as if a navigation bar were reserved out of its window — then corrected by a `Page.onResize` the real containers never send.
 */
function initialLayout(miniApp: DeviceShellProps['miniApp'], bridgeId: string): MiniAppFrameLayoutState {
  const top = makeLaunchPageEntry(miniApp, bridgeId)
  return {
    top,
    mounted: [{ entry: top, visible: true }],
    tabBarVisible: !!miniApp.getTabBarConfig(),
  }
}

export function DeviceShell(
  { miniApp, bridgeId, platform = 'ios', active = true }: DeviceShellProps,
) {
  const embedded = new URLSearchParams(window.location.search).get('embedded') === '1'
  const orientationHost = miniApp as typeof miniApp & Required<Pick<typeof miniApp, 'notifyApiResponse' | 'notifyResize'>>
  const [device, setDevice] = useState<NativeDeviceInfo | null>(() => miniApp.getInitialDevice())
  const [layout, setLayout] = useState<MiniAppFrameLayoutState>(() => initialLayout(miniApp, bridgeId))
  const notchType = device?.notchType ?? 'none'
  const { orientedMetrics, orientedBottomInset, publishTopResize, applyDevice } = useOrientation(orientationHost, layout, device)
  // Follows the top page's effective orientation, not the device's portrait baseline: a notched phone's landscape home indicator is thinner, and this is the same inset the page's reported window height is computed against.
  const bottomInset = embedded ? 0 : orientedBottomInset

  useEffect(() => miniApp.onSimulatorEvent<NativeDeviceInfo>(E.DEVICE_CHANGE, (next) => {
    applyDevice(next)
    setDevice(next)
  }), [applyDevice, miniApp])

  useEffect(() => attachApiCallForwarding(miniApp), [miniApp])

  // 软重载期间两个 shell 同时挂着，主进程要按「谁在屏幕上」而不是「谁最后报过几何」来定方向与视图尺寸，所以升为前台时补发一次当前顶页的几何（emitSessionOrientation 带 active 标记，见 bridge-router 的 applyPageResize）。
  //
  // 只跟 active 的跃迁走，不跟 layout.top 走：路由落地那条几何 MiniAppFrame 自己已经发过，这里再跟着顶页变化发一次就是同一份几何的第二个发布者，主进程的 hostEnv 与会话方向会被重复改写，路由几何也不再只有一个 owner。
  const topRef = useRef(layout.top)
  useEffect(() => {
    topRef.current = layout.top
  }, [layout.top])
  useEffect(() => {
    if (!active) return
    miniApp.notifySessionActive()
    publishTopResize(topRef.current)
  }, [active, miniApp, publishTopResize])

  const statusBarHeight = embedded ? 0 : (orientedMetrics?.statusBarHeight
    ?? (platform === 'ios' ? STATUS_BAR_HEIGHT_IOS : STATUS_BAR_HEIGHT_ANDROID))
  const handleMore = useCallback((context: CapsuleMoreContext) => {
    dispatchSimulatorCapsuleMore(context.appId, context.appName, context.pagePath)
  }, [])
  const publishLayout = useCallback((next: MiniAppFrameLayoutState) => {
    setLayout(next)
    publishTopResize(next.top, next.tabBarVisible)
  }, [publishTopResize])
  const frameLayout = useMemo(() => (next: MiniAppFrameLayoutState) => {
    setLayout((previous) => {
      const sameMounted = previous.mounted.length === next.mounted.length
        && previous.mounted.every((page, index) => {
          const candidate = next.mounted[index]
          return candidate?.entry === page.entry && candidate.visible === page.visible
        })
      if (previous.top === next.top
        && sameMounted
        && previous.tabBarVisible === next.tabBarVisible) return previous
      return next
    })
  }, [])

  return (
    <main className={`device-shell-root${embedded ? ' device-shell-root--embedded' : ''}`}>
      <section
        className={`device-shell${embedded ? ' device-shell--embedded' : ''}`}
        aria-label="Dimina simulator"
        style={!embedded && orientedMetrics
          ? { width: orientedMetrics.screenWidth, height: orientedMetrics.screenHeight }
          : undefined}
      >
        <MiniAppFrame
          host={miniApp}
          bridgeId={bridgeId}
          platform={platform}
          statusBarHeight={statusBarHeight}
          bottomInset={bottomInset}
          onMore={handleMore}
          onLayoutState={frameLayout}
          onLayoutCommit={publishLayout}
          statusBar={embedded || statusBarHeight <= 0 ? undefined : ({ textStyle }) => (
            <StatusBar
              height={statusBarHeight}
              notchType={notchType}
              textStyle={textStyle}
            />
          )}
          deviceOverlay={(
            <>
              <SimulatorUiExtensionLayer active={active} appId={miniApp.appId} />
              {bottomInset > 0 && (
                <div
                  className="device-shell__home-indicator"
                  style={{ height: bottomInset }}
                  aria-hidden="true"
                />
              )}
            </>
          )}
        />
      </section>
    </main>
  )
}
