/**
 * The phone the simulator pretends to be: bezel, screen geometry, status bar,
 * notch and home indicator, plus the devtools-only layers that ride along
 * (the UI extension mount point and the capsule "more" menu).
 *
 * The mini-app inside it is `MiniAppFrame`, which the runtime owns. Everything
 * this file computes from the selected device reaches the frame as two numbers,
 * so a host with no device pretense renders the same mini-app by passing
 * different ones — or none.
 */
import { useCallback, useEffect, useState } from 'react'
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
  type CapsuleMoreContext,
} from '@dimina-kit/electron-runtime/simulator-ui'
import './device-shell.css'

export type { DeviceShellProps } from './device-shell-types'

const STATUS_BAR_HEIGHT_IOS = 44
const STATUS_BAR_HEIGHT_ANDROID = 24

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

  // ── invokeAPI fallback (main → simulator) — see api-call-forwarding.ts ─────
  // Stays out of the frame: it dispatches into this product's own wx.* handler
  // registry, which the runtime knows nothing about.
  useEffect(() => attachApiCallForwarding(miniApp), [miniApp])

  const handleMore = useCallback((context: CapsuleMoreContext) => {
    dispatchSimulatorCapsuleMore(context.appId, context.appName, context.pagePath)
  }, [])

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
        <MiniAppFrame
          host={miniApp}
          bridgeId={bridgeId}
          platform={platform}
          statusBarHeight={statusBarHeight}
          bottomInset={bottomInset}
          onMore={handleMore}
          // Status bar overlay (time / icons / notch) pinned to the device top,
          // above both the nav-bar and the page webview. The nav-bar still
          // reserves `statusBarHeight` below it (paddingTop), so default nav
          // blends its bg up into the status area while custom nav shows the
          // page through it.
          statusBar={embedded ? undefined : ({ textStyle }) => (
            <StatusBar
              height={statusBarHeight}
              notchType={notchType}
              textStyle={textStyle}
            />
          )}
          deviceOverlay={(
            <>
              <SimulatorUiExtensionLayer active={active} appId={miniApp.appId} />
              {/* Home-indicator pill — an absolute overlay at the device bottom
                  (gesture-bar devices only; the home-button SE class has bottom
                  inset 0). It is NOT in flow: a tab page sees the tabBar's color
                  behind it, a non-tab page is full-bleed so its own content shows
                  through. The page reserves bottom space only via its own
                  env(safe-area-inset-*). */}
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
