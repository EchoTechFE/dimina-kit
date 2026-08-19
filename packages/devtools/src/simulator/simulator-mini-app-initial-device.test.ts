/**
 * `SimulatorMiniApp.getInitialDevice()` must report the device that is selected NOW, not the one frozen into the native-host bridge config when the simulator document loaded.
 *
 * DeviceShell reads it once for its very first render and only then registers its own DEVICE_CHANGE listener.
 * A device switched between `spawn()` resolving and DeviceShell mounting reaches the app (it subscribes before spawning) but not the shell's listener, and nothing replays it — so the shell would keep drawing the boot device until the user happens to switch again.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { SIMULATOR_EVENTS } from '../shared/bridge-channels'
import type { NativeDeviceInfo } from '../shared/ipc-channels'
import { SimulatorMiniApp } from './simulator-mini-app'

type Listener = (payload: unknown) => void

const BOOT_DEVICE: NativeDeviceInfo = {
  brand: 'Apple',
  model: 'iPhone SE',
  system: 'iOS 16.0',
  platform: 'ios',
  pixelRatio: 2,
  screenWidth: 375,
  screenHeight: 667,
  statusBarHeight: 20,
  notchType: 'none',
  safeAreaInsets: { top: 20, right: 0, bottom: 0, left: 0 },
  deviceOrientation: 'portrait',
}

const SWITCHED_DEVICE: NativeDeviceInfo = {
  ...BOOT_DEVICE,
  model: 'iPhone 14 Pro Max',
  pixelRatio: 3,
  screenWidth: 430,
  screenHeight: 932,
  statusBarHeight: 54,
  notchType: 'dynamic-island',
  safeAreaInsets: { top: 54, right: 0, bottom: 34, left: 0 },
  deviceOrientation: 'landscape',
}

function installNativeHostMock() {
  const listeners = new Map<string, Set<Listener>>()
  const host = {
    enabled: true,
    device: BOOT_DEVICE,
    spawn: async () => ({
      appSessionId: 's1',
      bridgeId: 'b1',
      pagePath: 'pages/index/index',
      resolvedPagePath: 'pages/index/index',
      pageFallbackApplied: false,
      serviceWcId: 1,
      resourceBaseUrl: '',
      root: 'main',
      manifest: { pages: ['pages/index/index'], entryPagePath: 'pages/index/index', source: 'app-config' },
      rootWindowConfig: {},
    }),
    dispose: () => {},
    openPage: async () => ({ bridgeId: 'unused', pagePath: 'unused', windowConfig: {}, isTab: false }),
    closePage: () => {},
    notifyLifecycle: () => {},
    notifyNavCallback: () => {},
    notifyApiResponse: () => {},
    notifyActivePage: () => {},
    notifyPageStack: () => {},
    notifyResize: () => {},
    createRenderHostUrl: () => 'about:blank',
    renderPreloadUrl: 'about:blank',
    onSimulatorEvent: (channel: string, listener: Listener) => {
      let set = listeners.get(channel)
      if (!set) { set = new Set(); listeners.set(channel, set) }
      set.add(listener)
      return () => { set?.delete(listener) }
    },
  }
  window.__diminaNativeHost = host as unknown as Window['__diminaNativeHost']
  return {
    emitDeviceChange: (device: NativeDeviceInfo) => {
      for (const fn of listeners.get(SIMULATOR_EVENTS.DEVICE_CHANGE) ?? []) fn(device)
    },
  }
}

afterEach(() => {
  delete (window as { __diminaNativeHost?: unknown }).__diminaNativeHost
})

describe('SimulatorMiniApp.getInitialDevice', () => {
  it('returns the boot config device before any DEVICE_CHANGE arrives', async () => {
    installNativeHostMock()
    const app = new SimulatorMiniApp({ appId: 'a', scene: 1001, pagePath: 'pages/index/index' })
    await app.spawn()

    expect(app.getInitialDevice()).toEqual(BOOT_DEVICE)
  })

  it('returns a device switched between spawn resolving and the shell mounting', async () => {
    const host = installNativeHostMock()
    const app = new SimulatorMiniApp({ appId: 'a', scene: 1001, pagePath: 'pages/index/index' })
    await app.spawn()

    host.emitDeviceChange(SWITCHED_DEVICE)

    expect(app.getInitialDevice()).toEqual(SWITCHED_DEVICE)
    expect(app.getDeviceMetrics()).toMatchObject({
      screenWidth: 430,
      screenHeight: 932,
      deviceOrientation: 'landscape',
    })
  })
})
