/**
 * DeviceShell wraps MiniAppFrame in <device-frame> instead of hand-
 * drawing the bezel/status-bar/home-indicator: the frame element's
 * device/orientation attributes track the selected device (initial +
 * DEVICE_CHANGE), its status-bar-text-style attribute follows the render
 * prop MiniAppFrame calls back with, MiniAppFrame's own `platform` prop
 * follows the device's platform (harmony borrows android's nav-bar style),
 * and embedded mode drops the frame chrome and the status-bar/bottom-inset
 * numbers alike. The hand-drawn `.device-statusbar` / home-indicator markup
 * must be gone.
 */
import React from 'react'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEVICE_NAMES } from '@devicekit/devices'
import { SIMULATOR_EVENTS } from '../../shared/bridge-channels'
import type { NativeDeviceInfo } from '../../shared/ipc-channels'
import type { SimulatorMiniApp } from '../simulator-mini-app'

// ─── MiniAppFrame stub ────────────────────────────────────────────────────
//
// Calls the `statusBar` render prop with a test-controlled chrome (so its
// returned no-DOM component's effect can push textStyle back up into
// DeviceShell state) and renders `deviceOverlay` verbatim, mirroring the real
// component's two extension points without pulling in electron-runtime.
const mockChrome = vi.hoisted(() => ({ textStyle: 'black' as 'white' | 'black' }))

vi.mock('@dimina-kit/electron-runtime/simulator-ui', () => ({
  MiniAppFrame: (props: {
    platform: string
    statusBarHeight: number
    bottomInset: number
    statusBar?: (chrome: { textStyle: 'white' | 'black' }) => React.ReactNode
    deviceOverlay?: React.ReactNode
  }) => (
    <div
      data-mock-miniappframe
      data-platform={props.platform}
      data-status-bar-height={props.statusBarHeight}
      data-bottom-inset={props.bottomInset}
    >
      {props.statusBar?.(mockChrome)}
      {props.deviceOverlay}
    </div>
  ),
}))

import { DeviceShell } from './device-shell'

type Listener = (payload: unknown) => void

function makeFakeMiniApp(opts: {
  initialDevice?: NativeDeviceInfo | null
  platform?: 'ios' | 'android'
} = {}) {
  const listeners = new Map<string, Set<Listener>>()
  const on = (channel: string, listener: Listener) => {
    let set = listeners.get(channel)
    if (!set) {
      set = new Set()
      listeners.set(channel, set)
    }
    set.add(listener)
    return () => { set!.delete(listener) }
  }
  const miniApp = {
    appId: 'testapp',
    apiRegistry: {},
    platform: opts.platform ?? 'ios',
    getInitialDevice: () => opts.initialDevice ?? null,
    onSimulatorEvent: on,
    onSessionEvent: on,
    notifyApiResponse: vi.fn(),
    fire(channel: string, payload: unknown) {
      const set = listeners.get(channel)
      for (const fn of [...(set ?? [])]) fn(payload)
    },
  }
  return miniApp as unknown as SimulatorMiniApp & { fire: (channel: string, payload: unknown) => void }
}

const IPHONE_15: NativeDeviceInfo = {
  device: DEVICE_NAMES.iPhone_15,
  brand: 'Apple',
  model: 'iPhone 15',
  system: 'iOS 18.5',
  platform: 'ios',
  orientation: 'portrait',
  pixelRatio: 3,
  screenWidth: 393,
  screenHeight: 852,
  statusBarHeight: 54,
  safeAreaInsets: { top: 59, right: 0, bottom: 34, left: 0 },
} as unknown as NativeDeviceInfo

const PIXEL_8_LANDSCAPE: NativeDeviceInfo = {
  device: DEVICE_NAMES.Pixel_8,
  brand: 'Google',
  model: 'Pixel 8',
  system: 'Android 14',
  platform: 'android',
  orientation: 'landscape',
  pixelRatio: 2.625,
  screenWidth: 915,
  screenHeight: 412,
  statusBarHeight: 50,
  safeAreaInsets: { top: 0, right: 50, bottom: 0, left: 0 },
} as unknown as NativeDeviceInfo

function frameEl(container: HTMLElement): Element | null {
  return container.querySelector('device-frame')
}

function setRoute(search = ''): void {
  window.history.replaceState({}, '', `/simulator.html${search}`)
}

beforeEach(() => {
  setRoute()
  mockChrome.textStyle = 'black'
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('DeviceShell: renders <device-frame> tracking the selected device', () => {
  it('sets device/orientation attributes from the initial device', () => {
    const miniApp = makeFakeMiniApp({ initialDevice: IPHONE_15 })
    const { container } = render(<DeviceShell miniApp={miniApp} bridgeId="b1" />)

    const el = frameEl(container)
    expect(el).toBeTruthy()
    expect(el!.getAttribute('device')).toBe(DEVICE_NAMES.iPhone_15)
    expect(el!.getAttribute('orientation')).toBe('portrait')
  })

  it('updates device/orientation attributes on a DEVICE_CHANGE event', () => {
    const miniApp = makeFakeMiniApp({ initialDevice: IPHONE_15 })
    const { container } = render(<DeviceShell miniApp={miniApp} bridgeId="b1" />)

    act(() => {
      miniApp.fire(SIMULATOR_EVENTS.DEVICE_CHANGE, PIXEL_8_LANDSCAPE)
    })

    const el = frameEl(container)
    expect(el!.getAttribute('device')).toBe(DEVICE_NAMES.Pixel_8)
    expect(el!.getAttribute('orientation')).toBe('landscape')
  })
})

describe('DeviceShell: status-bar-text-style follows the MiniAppFrame statusBar render prop', () => {
  it('reflects textStyle: "white" on the frame element', () => {
    const miniApp = makeFakeMiniApp({ initialDevice: IPHONE_15 })
    const { container, rerender } = render(<DeviceShell miniApp={miniApp} bridgeId="b1" />)

    mockChrome.textStyle = 'white'
    act(() => {
      rerender(<DeviceShell miniApp={miniApp} bridgeId="b1" />)
    })

    expect(frameEl(container)!.getAttribute('status-bar-text-style')).toBe('white')
  })
})

describe('DeviceShell: MiniAppFrame platform follows the device, harmony borrows android', () => {
  it('passes "android" for an android device', () => {
    const miniApp = makeFakeMiniApp({ initialDevice: { ...IPHONE_15, device: DEVICE_NAMES.Pixel_8, platform: 'android' } })
    const { container } = render(<DeviceShell miniApp={miniApp} bridgeId="b1" />)
    expect(container.querySelector('[data-mock-miniappframe]')!.getAttribute('data-platform')).toBe('android')
  })

  it('passes "android" for a harmony device (borrows android nav-bar style)', () => {
    const miniApp = makeFakeMiniApp({ initialDevice: { ...IPHONE_15, device: DEVICE_NAMES.HUAWEI_Mate_60_Pro, platform: 'harmony' } })
    const { container } = render(<DeviceShell miniApp={miniApp} bridgeId="b1" />)
    expect(container.querySelector('[data-mock-miniappframe]')!.getAttribute('data-platform')).toBe('android')
  })

  it('passes "ios" for an ios device', () => {
    const miniApp = makeFakeMiniApp({ initialDevice: IPHONE_15 })
    const { container } = render(<DeviceShell miniApp={miniApp} bridgeId="b1" />)
    expect(container.querySelector('[data-mock-miniappframe]')!.getAttribute('data-platform')).toBe('ios')
  })
})

describe('DeviceShell: embedded mode', () => {
  it('renders the frame with an embedded attribute and zeroes statusBarHeight/bottomInset', () => {
    setRoute('?embedded=1')
    const miniApp = makeFakeMiniApp({ initialDevice: IPHONE_15 })
    const { container } = render(<DeviceShell miniApp={miniApp} bridgeId="b1" />)

    expect(frameEl(container)!.hasAttribute('embedded')).toBe(true)
    const frame = container.querySelector('[data-mock-miniappframe]')!
    expect(frame.getAttribute('data-status-bar-height')).toBe('0')
    expect(frame.getAttribute('data-bottom-inset')).toBe('0')
  })
})

describe('DeviceShell: hand-drawn chrome is gone', () => {
  it('renders no .device-statusbar or .device-shell__home-indicator element', () => {
    const miniApp = makeFakeMiniApp({ initialDevice: IPHONE_15 })
    const { container } = render(<DeviceShell miniApp={miniApp} bridgeId="b1" />)

    expect(container.querySelector('.device-statusbar')).toBeNull()
    expect(container.querySelector('.device-shell__home-indicator')).toBeNull()
  })
})
