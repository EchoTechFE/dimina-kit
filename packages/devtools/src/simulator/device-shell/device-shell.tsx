/**
 * The phone the simulator pretends to be: `<device-frame>` owns the
 * bezel, screen geometry, status bar and home indicator (the 171-device
 * table, not a hand-drawn shell). This file only wires the selected device
 * into the frame's attributes/property and the mini-app into its light DOM.
 *
 * The mini-app inside it is `MiniAppFrame`, which the runtime owns. Everything
 * this file computes from the selected device reaches the frame as two numbers,
 * so a host with no device pretense renders the same mini-app by passing
 * different ones — or none.
 *
 * MiniAppFrame draws its own navigation bar (with the status-bar inset padded
 * in) and reserves the bottom inset itself, so the frame is `immersive`: its
 * content area runs the full screen from y=0 instead of starting below the
 * status bar. MiniAppFrame also renders a fragment (nav bar, page viewport,
 * tab bar) that expects a flex column parent — the frame's slot container is
 * a plain block, so `.device-shell__screen` supplies that column.
 */
import { useCallback, useEffect, useState } from 'react'
import { DeviceFrame } from '@devicekit/frame/react'
import type { StatusBarTextStyle } from '@devicekit/frame'
import { findDevice, PLATFORM_DEFAULTS, type DeviceOS, type DeviceProfile } from '@devicekit/devices'
import { SIMULATOR_EVENTS as E } from '../../shared/bridge-channels'
import type { DeviceShellProps } from './device-shell-types'
import { attachApiCallForwarding } from '../api-call-forwarding'
import type { NativeDeviceInfo } from '../../shared/ipc-channels'
import {
  dispatchSimulatorCapsuleMore,
  SimulatorUiExtensionLayer,
} from './simulator-ui-extension-layer'
import {
  MiniAppFrame,
  type CapsuleMoreContext,
  type NavBarPlatform,
} from '@dimina-kit/electron-runtime/simulator-ui'
import './device-shell.css'

export type { DeviceShellProps } from './device-shell-types'

/**
 * `NativeDeviceInfo.device` is a lookup key into the @devicekit/devices table;
 * it is absent for a custom/legacy payload (no matching name). In that case we
 * reconstruct a one-off `DeviceProfile` from the numbers already resolved for
 * the CURRENT orientation, un-swapping back to the portrait-only `screen` shape
 * the frame expects.
 */
function fallbackProfile(d: NativeDeviceInfo): DeviceProfile {
  const screen = d.orientation === 'landscape'
    ? { width: d.screenHeight, height: d.screenWidth }
    : { width: d.screenWidth, height: d.screenHeight }
  return {
    name: d.device ?? d.model,
    os: d.platform as DeviceOS,
    screen,
    pixelRatio: d.pixelRatio,
    system: d.system,
    statusBarHeight: d.statusBarHeight,
    ...(d.orientation === 'landscape'
      ? { safeAreaInsetsLandscape: d.safeAreaInsets }
      : { safeAreaInsets: d.safeAreaInsets }),
  }
}

/**
 * No-DOM bridge from MiniAppFrame's `statusBar` render prop to DeviceShell's
 * own state — the frame (not MiniAppFrame) draws the status bar now, so this
 * component's only job is forwarding `textStyle` up in an effect. Reading it
 * during render and calling `setState` there would fire mid-render on the
 * PARENT, which React disallows.
 */
function StatusBarTextStyleBridge(
  { textStyle, onChange }: { textStyle: StatusBarTextStyle; onChange: (t: StatusBarTextStyle) => void },
) {
  useEffect(() => { onChange(textStyle) }, [textStyle, onChange])
  return null
}

export function DeviceShell(
  { miniApp, bridgeId, active = true }: DeviceShellProps,
) {
  const embedded = new URLSearchParams(window.location.search).get('embedded') === '1'
  // The selected device drives the frame's bezel + status bar + notch. Initial
  // value rides the native-host bridge config (race-free); live toolbar
  // changes arrive over DEVICE_CHANGE.
  const [device, setDevice] = useState<NativeDeviceInfo | null>(() => miniApp.getInitialDevice())
  useEffect(() => miniApp.onSimulatorEvent<NativeDeviceInfo>(E.DEVICE_CHANGE, setDevice), [miniApp])
  const [statusBarTextStyle, setStatusBarTextStyle] = useState<StatusBarTextStyle>('black')

  // Chrome metrics MiniAppFrame reserves layout space for — the frame itself
  // draws the status bar and home indicator, MiniAppFrame only needs to know
  // how much of its top/bottom to pad. Falls back to the platform default
  // (single source: @devicekit/devices) before the first device arrives.
  const statusBarHeight = embedded
    ? 0
    : (device?.safeAreaInsets.top ?? PLATFORM_DEFAULTS[miniApp.platform].statusBarHeight)
  const bottomInset = embedded ? 0 : (device?.safeAreaInsets.bottom ?? 0)

  // NavigationBar style follows the selected device, not the session's boot-time
  // platform — a single owner instead of two fields that can disagree. Only
  // falls back to `miniApp.platform` before any device has arrived.
  const navBarPlatform: NavBarPlatform = device
    ? (device.platform === 'ios' ? 'ios' : 'android')
    : miniApp.platform

  const resolvedProfile = device && !findDevice(device.device) ? fallbackProfile(device) : null

  // ── invokeAPI fallback (main → simulator) — see api-call-forwarding.ts ─────
  // Stays out of the frame: it dispatches into this product's own wx.* handler
  // registry, which the runtime knows nothing about.
  useEffect(() => attachApiCallForwarding(miniApp), [miniApp])

  const handleMore = useCallback((context: CapsuleMoreContext) => {
    dispatchSimulatorCapsuleMore(context.appId, context.appName, context.pagePath)
  }, [])

  return (
    <main className={`device-shell-root${embedded ? ' device-shell-root--embedded' : ''}`}>
      <DeviceFrame
        device={device?.device}
        deviceProfile={resolvedProfile}
        orientation={device?.orientation ?? 'portrait'}
        embedded={embedded}
        immersive
        statusBarTextStyle={statusBarTextStyle}
        className={`device-shell${embedded ? ' device-shell--embedded' : ''}`}
        aria-label="Dimina simulator"
      >
        <div className="device-shell__screen">
          <MiniAppFrame
            host={miniApp}
            bridgeId={bridgeId}
            platform={navBarPlatform}
            statusBarHeight={statusBarHeight}
            bottomInset={bottomInset}
            onMore={handleMore}
            statusBar={embedded ? undefined : ({ textStyle }) => (
              <StatusBarTextStyleBridge textStyle={textStyle} onChange={setStatusBarTextStyle} />
            )}
            deviceOverlay={<SimulatorUiExtensionLayer active={active} appId={miniApp.appId} />}
          />
        </div>
      </DeviceFrame>
    </main>
  )
}
