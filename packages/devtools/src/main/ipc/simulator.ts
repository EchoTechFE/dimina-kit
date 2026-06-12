import { ServiceHostChannel, SimulatorChannel, SimulatorCustomApiChannel } from '../../shared/ipc-channels.js'
import {
  SimulatorAttachNativeSchema,
  SimulatorCustomApiInvokeSchema,
  SimulatorSetDeviceInfoSchema,
  SimulatorSetNativeBoundsSchema,
} from '../../shared/ipc-schemas.js'
import { deviceInfoToHostEnv } from '../../shared/bridge-channels.js'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { Disposable } from '@dimina-kit/electron-deck/main'
import { validate } from '../utils/ipc-schema.js'
import { IpcRegistry } from '../utils/ipc-registry.js'

export function registerSimulatorIpc(ctx: Pick<WorkbenchContext, 'views' | 'notify' | 'senderPolicy' | 'simulatorApis' | 'bridge'>): Disposable {
  return new IpcRegistry(ctx.senderPolicy)
    .handle(SimulatorChannel.AttachNative, (_, ...args: unknown[]) => {
      const [simulatorUrl, simWidth] = validate(SimulatorChannel.AttachNative, SimulatorAttachNativeSchema, args)
      ctx.views.attachNativeSimulator(simulatorUrl, simWidth)
    })
    .handle(SimulatorChannel.Detach, () => {
      ctx.views.detachSimulator()
    })
    .handle(SimulatorChannel.SetNativeBounds, (_, ...args: unknown[]) => {
      const [p] = validate(SimulatorChannel.SetNativeBounds, SimulatorSetNativeBoundsSchema, args)
      ctx.views.setNativeSimulatorViewBounds(p)
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
      const serviceWc = ctx.bridge?.getServiceWc()
      if (serviceWc && !serviceWc.isDestroyed()) {
        serviceWc.send(ServiceHostChannel.HostEnvUpdate, deviceInfoToHostEnv(device))
      }
    })
    .handle(SimulatorCustomApiChannel.Invoke, (_, ...args: unknown[]) => {
      const [name, params] = validate(SimulatorCustomApiChannel.Invoke, SimulatorCustomApiInvokeSchema, args)
      return ctx.simulatorApis.invoke(name, params)
    })
}
