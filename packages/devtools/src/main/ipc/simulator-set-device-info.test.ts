/**
 * `simulator:set-device-info` must not push window geometry to a running service host.
 *
 * DeviceShell is the only place that knows the visible page's orientation config and chrome (nav bar / tab bar), and it publishes the resulting geometry over PAGE_RESIZE.
 * A raw device→host-env mapping knows neither, so sending it here would install a snapshot that `wx.getSystemInfoSync()` answers from — with the device's own orientation and only the status bar deducted — until the shell's PAGE_RESIZE arrives.
 *
 * The device identity (model / brand / system / platform / pixelRatio / portrait-baseline safe-area insets) still has to reach the service host right away: nothing else republishes it when the user picks another phone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const stub = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown
  const handled = new Map<string, Handler>()
  return {
    handled,
    ipcMain: {
      handle: vi.fn((channel: string, fn: Handler) => {
        handled.set(channel, fn)
      }),
      removeHandler: vi.fn((channel: string) => {
        handled.delete(channel)
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
      removeAllListeners: vi.fn(),
    },
  }
})

vi.mock('electron', () => ({
  ipcMain: stub.ipcMain,
  default: { ipcMain: stub.ipcMain },
}))

const DEVICE = {
  brand: 'Apple',
  model: 'iPhone 14',
  system: 'iOS 16.0',
  platform: 'ios',
  pixelRatio: 3,
  screenWidth: 390,
  screenHeight: 844,
  statusBarHeight: 47,
  notchType: 'dynamic-island' as const,
  safeAreaInsets: { top: 47, right: 0, bottom: 34, left: 0 },
  deviceOrientation: 'portrait' as const,
}

beforeEach(() => {
  stub.handled.clear()
  stub.ipcMain.handle.mockClear()
  vi.resetModules()
})

async function setupSimulatorIpc() {
  const { registerSimulatorIpc } = await import('./simulator.js')
  const serviceWc = { isDestroyed: () => false, send: vi.fn() }
  const ctx = {
    views: { reapplySafeArea: vi.fn() },
    notify: {},
    senderPolicy: undefined,
    simulatorApis: { invoke: vi.fn() },
    bridge: {
      setDevice: vi.fn(),
      getDevice: vi.fn(() => null),
      getServiceWc: () => serviceWc,
    },
  }
  const disposable = registerSimulatorIpc(ctx as never)
  return { ctx, serviceWc, disposable }
}

describe('registerSimulatorIpc: simulator:set-device-info → service-host host-env update', () => {
  it('sends the device identity but no window geometry — DeviceShell owns that and publishes it over PAGE_RESIZE', async () => {
    const { serviceWc, disposable } = await setupSimulatorIpc()
    const handler = stub.handled.get('simulator:set-device-info')
    expect(handler).toBeDefined()

    await handler?.({}, DEVICE)

    expect(serviceWc.send).toHaveBeenCalledTimes(1)
    const [, patch] = serviceWc.send.mock.calls[0] as [string, Record<string, unknown>]

    for (const key of [
      'screenWidth',
      'screenHeight',
      'windowWidth',
      'windowHeight',
      'statusBarHeight',
      'deviceOrientation',
    ]) {
      expect(patch).not.toHaveProperty(key)
    }
    expect(patch).toMatchObject({
      brand: 'Apple',
      model: 'iPhone 14',
      system: 'iOS 16.0',
      platform: 'ios',
      pixelRatio: 3,
      safeAreaInsets: { top: 47, right: 0, bottom: 34, left: 0 },
    })

    await disposable.dispose()
  })

  it('still caches the selection and re-applies the CSS safe-area override', async () => {
    const { ctx, disposable } = await setupSimulatorIpc()
    await stub.handled.get('simulator:set-device-info')?.({}, DEVICE)

    expect(ctx.bridge.setDevice).toHaveBeenCalledWith(DEVICE)
    expect(ctx.views.reapplySafeArea).toHaveBeenCalledWith(DEVICE)

    await disposable.dispose()
  })

  it('keeps the pushed deviceOrientation — the payload schema must not strip the one field the rotate button changes', async () => {
    const { ctx, disposable } = await setupSimulatorIpc()
    await stub.handled.get('simulator:set-device-info')?.(
      {},
      { ...DEVICE, deviceOrientation: 'landscape' },
    )

    expect(ctx.bridge.setDevice).toHaveBeenCalledWith(
      expect.objectContaining({ deviceOrientation: 'landscape' }),
    )

    await disposable.dispose()
  })
})

describe('deviceIdentityHostEnv', () => {
  it('keeps a landscape device from leaking its swapped screen size into the patch', async () => {
    const { deviceIdentityHostEnv } = await import('./simulator.js')
    const patch = deviceIdentityHostEnv({ ...DEVICE, deviceOrientation: 'landscape' })
    expect(Object.keys(patch).sort()).toEqual([
      'brand',
      'model',
      'pixelRatio',
      'platform',
      'safeAreaInsets',
      'system',
    ])
  })
})
