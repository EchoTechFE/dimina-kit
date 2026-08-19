import { ServiceHostChannel, SimulatorChannel, SimulatorCustomApiChannel } from '../../shared/ipc-channels.js'
import {
  SimulatorAttachNativeSchema,
  SimulatorCustomApiInvokeSchema,
  SimulatorSetDeviceInfoSchema,
  SimulatorSoftReloadSchema,
} from '../../shared/ipc-schemas.js'
import { deviceInfoToHostEnv } from '../../shared/bridge-channels.js'
import type { HostEnvSnapshot } from '../../shared/bridge-channels.js'
import type { NativeDeviceInfo } from '../../shared/ipc-channels.js'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { Disposable } from '@dimina-kit/electron-deck/main'
import { validate } from '../utils/ipc-schema.js'
import { IpcRegistry } from '../utils/ipc-registry.js'

/**
 * Host-env keys that describe the mini-app WINDOW rather than the device.
 * Only DeviceShell can compute them: they depend on the top page's own orientation config and chrome (nav bar / tabBar), which a raw device record knows nothing about.
 * It publishes them over PAGE_RESIZE.
 */
const WINDOW_GEOMETRY_KEYS = [
  'screenWidth',
  'screenHeight',
  'windowWidth',
  'windowHeight',
  'statusBarHeight',
  'deviceOrientation',
] as const

/**
 * The device-identity slice of a host-env snapshot — model / brand / system / platform / pixelRatio / portrait-baseline safe-area insets.
 * Switching the simulated phone must refresh these on a running service host immediately, but pushing the device's raw geometry alongside them would install a snapshot that ignores the current page's orientation and chrome, so `wx.getSystemInfoSync()` would report wrong dimensions until DeviceShell's PAGE_RESIZE lands.
 */
export function deviceIdentityHostEnv(device: NativeDeviceInfo): Partial<HostEnvSnapshot> {
  const patch: Partial<HostEnvSnapshot> = { ...deviceInfoToHostEnv(device) }
  for (const key of WINDOW_GEOMETRY_KEYS) delete patch[key]
  return patch
}

export function registerSimulatorIpc(ctx: Pick<WorkbenchContext, 'views' | 'notify' | 'senderPolicy' | 'simulatorApis' | 'bridge'>): Disposable {
  return new IpcRegistry(ctx.senderPolicy)
    .handle(SimulatorChannel.AttachNative, (_, ...args: unknown[]) => {
      const [simulatorUrl, simWidth] = validate(SimulatorChannel.AttachNative, SimulatorAttachNativeSchema, args)
      return ctx.views.attachNativeSimulator(simulatorUrl, simWidth)
    })
    .handle(SimulatorChannel.SoftReload, (_, ...args: unknown[]) => {
      const [simulatorUrl] = validate(SimulatorChannel.SoftReload, SimulatorSoftReloadSchema, args)
      return ctx.views.softReloadNativeSimulator(simulatorUrl)
    })
    .handle(SimulatorChannel.Detach, () => {
      ctx.views.detachSimulator()
    })
    .handle(SimulatorChannel.SetDeviceInfo, (_, ...args: unknown[]) => {
      const [device] = validate(SimulatorChannel.SetDeviceInfo, SimulatorSetDeviceInfoSchema, args)
      // Cache the selection (rides the next NATIVE_HOST_ENABLED reply for a
      // race-free DeviceShell init) and push DEVICE_CHANGE to the live simulator
      // WCV so the DeviceShell resizes the bezel + re-renders status bar / notch.
      ctx.bridge?.setDevice(device)
      // Re-push the CSS env(safe-area-inset-*) override to attached render-host
      // guests so notch-aware page layout updates without a reload.
      ctx.views.reapplySafeArea(device)
      // Live-update the running service-host window's host-env snapshot so
      // `wx.getSystemInfoSync()` reflects the selected device without a relaunch.
      // The service-host preload mutates `__diminaSpawnContext` in place;
      // `getSystemInfoSync` reads it fresh on each call. No service window yet
      // (pre-spawn) → no-op.
      // Identity fields only: the window geometry belongs to DeviceShell's PAGE_RESIZE (see `deviceIdentityHostEnv`).
      const serviceWc = ctx.bridge?.getServiceWc()
      if (serviceWc && !serviceWc.isDestroyed()) {
        serviceWc.send(ServiceHostChannel.HostEnvUpdate, deviceIdentityHostEnv(device))
      }
    })
    .handle(SimulatorChannel.GetDeviceInfo, () => ctx.bridge?.getDevice() ?? null)
    .handle(SimulatorCustomApiChannel.Invoke, (_, ...args: unknown[]) => {
      const [name, params] = validate(SimulatorCustomApiChannel.Invoke, SimulatorCustomApiInvokeSchema, args)
      return ctx.simulatorApis.invoke(name, params)
    })
}
