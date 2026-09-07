import { SimulatorChannel, SimulatorCustomApiChannel } from '../../shared/ipc-channels.js'
import {
  SimulatorAttachNativeSchema,
  SimulatorCustomApiInvokeSchema,
  SimulatorSetDeviceInfoSchema,
  SimulatorSoftReloadSchema,
} from '../../shared/ipc-schemas.js'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { Disposable } from '@dimina-kit/electron-deck/main'
import { validate } from '../utils/ipc-schema.js'
import { IpcRegistry } from '../utils/ipc-registry.js'
import { toIpcContextSource, type IpcInput } from '../utils/ipc-context-source.js'

type SimulatorIpcCtx = Pick<
  WorkbenchContext,
  'views' | 'notify' | 'senderPolicy' | 'simulatorApis' | 'bridge'
>

export function registerSimulatorIpc(input: IpcInput<SimulatorIpcCtx>): Disposable {
  return new IpcRegistry(toIpcContextSource(input))
    .handleRouted(SimulatorChannel.AttachNative, (ctx, _e, ...args: unknown[]) => {
      const [simulatorUrl, simWidth] = validate(SimulatorChannel.AttachNative, SimulatorAttachNativeSchema, args)
      return ctx.views.attachNativeSimulator(simulatorUrl, simWidth)
    })
    .handleRouted(SimulatorChannel.SoftReload, (ctx, _e, ...args: unknown[]) => {
      const [simulatorUrl] = validate(SimulatorChannel.SoftReload, SimulatorSoftReloadSchema, args)
      return ctx.views.softReloadNativeSimulator(simulatorUrl)
    })
    .handleRouted(SimulatorChannel.Detach, (ctx) => {
      ctx.views.detachSimulator()
    })
    .handleRouted(SimulatorChannel.SetDeviceInfo, (ctx, _e, ...args: unknown[]) => {
      const [device] = validate(SimulatorChannel.SetDeviceInfo, SimulatorSetDeviceInfoSchema, args)
      // Cache the selection (rides the next NATIVE_HOST_ENABLED reply for a
      // race-free DeviceShell init) and push DEVICE_CHANGE to the live simulator
      // WCV so the DeviceShell resizes the bezel + re-renders status bar / notch.
      // `setDevice` also pushes `hostEnvUpdate` + `pageResize` to every running
      // service host, so `wx.getSystemInfoSync()` and `Page.onResize` follow
      // the selection without a relaunch.
      ctx.bridge?.setDevice(device)
      // Re-push the CSS env(safe-area-inset-*) override to attached render-host
      // guests so notch-aware page layout updates without a reload.
      ctx.views.reapplySafeArea(device)
    })
    .handleRouted(SimulatorCustomApiChannel.Invoke, (ctx, _e, ...args: unknown[]) => {
      const [name, params] = validate(SimulatorCustomApiChannel.Invoke, SimulatorCustomApiInvokeSchema, args)
      return ctx.simulatorApis.invoke(name, params)
    })
}
