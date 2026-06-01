import { ServiceHostChannel, SimulatorChannel, SimulatorCustomApiChannel } from '../../shared/ipc-channels.js'
import type { NativeDeviceInfo } from '../../shared/ipc-channels.js'
import {
  SimulatorAttachNativeSchema,
  SimulatorAttachSchema,
  SimulatorCustomApiInvokeSchema,
  SimulatorResizeSchema,
  SimulatorSetDeviceInfoSchema,
  SimulatorSetNativeBoundsSchema,
  SimulatorSetVisibleSchema,
} from '../../shared/ipc-schemas.js'
import type { HostEnvSnapshot } from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { Disposable } from '../utils/disposable.js'
import { validate } from '../utils/ipc-schema.js'
import { IpcRegistry } from '../utils/ipc-registry.js'

/**
 * Map the renderer's logical device metrics onto the subset of a
 * HostEnvSnapshot the service-host window's `getSystemInfoSync` consumes.
 * `windowHeight` excludes the status bar (the page area); `windowWidth` has no
 * horizontal chrome. Zoom is intentionally absent — it is a display scale, not
 * a logical-size change.
 */
function deviceInfoToHostEnv(d: NativeDeviceInfo): Partial<HostEnvSnapshot> {
  return {
    brand: d.brand,
    model: d.model,
    system: d.system,
    platform: d.platform,
    pixelRatio: d.pixelRatio,
    screenWidth: d.screenWidth,
    screenHeight: d.screenHeight,
    windowWidth: d.screenWidth,
    windowHeight: Math.max(0, d.screenHeight - d.statusBarHeight),
    statusBarHeight: d.statusBarHeight,
  }
}

export function registerSimulatorIpc(ctx: Pick<WorkbenchContext, 'views' | 'notify' | 'senderPolicy' | 'simulatorApis' | 'bridge'>): Disposable {
  return new IpcRegistry(ctx.senderPolicy)
    .handle(SimulatorChannel.Attach, (_, ...args: unknown[]) => {
      const [simWcId, simWidth] = validate(SimulatorChannel.Attach, SimulatorAttachSchema, args)
      ctx.views.attachSimulator(simWcId, simWidth)
    })
    .handle(SimulatorChannel.AttachNative, (_, ...args: unknown[]) => {
      const [simulatorUrl, simWidth] = validate(SimulatorChannel.AttachNative, SimulatorAttachNativeSchema, args)
      ctx.views.attachNativeSimulator(simulatorUrl, simWidth)
    })
    .handle(SimulatorChannel.Detach, () => {
      ctx.views.detachSimulator()
    })
    .handle(SimulatorChannel.Resize, (_, ...args: unknown[]) => {
      const [simWidth] = validate(SimulatorChannel.Resize, SimulatorResizeSchema, args)
      ctx.views.resize(simWidth)
    })
    .handle(SimulatorChannel.SetNativeBounds, (_, ...args: unknown[]) => {
      const [p] = validate(SimulatorChannel.SetNativeBounds, SimulatorSetNativeBoundsSchema, args)
      ctx.views.setNativeSimulatorViewBounds(p)
    })
    .handle(SimulatorChannel.SetDeviceInfo, (_, ...args: unknown[]) => {
      const [device] = validate(SimulatorChannel.SetDeviceInfo, SimulatorSetDeviceInfoSchema, args)
      // Native-host only: live-update the running service-host window's host-env
      // snapshot so `wx.getSystemInfoSync()` reflects the selected device without
      // a relaunch. The service-host preload mutates `__diminaSpawnContext`
      // in place; `getSystemInfoSync` reads it fresh on each call. No service
      // window yet (default path / pre-spawn) → no-op.
      const serviceWc = ctx.bridge?.getServiceWc()
      if (serviceWc && !serviceWc.isDestroyed()) {
        serviceWc.send(ServiceHostChannel.HostEnvUpdate, deviceInfoToHostEnv(device))
      }
    })
    .handle(SimulatorChannel.SetVisible, (_, ...args: unknown[]) => {
      const [visible, simWidth] = validate(SimulatorChannel.SetVisible, SimulatorSetVisibleSchema, args)
      ctx.views.setVisible(visible, simWidth)
    })
    .handle(SimulatorCustomApiChannel.List, () => {
      return ctx.simulatorApis.list()
    })
    .handle(SimulatorCustomApiChannel.Invoke, (_, ...args: unknown[]) => {
      const [name, params] = validate(SimulatorCustomApiChannel.Invoke, SimulatorCustomApiInvokeSchema, args)
      return ctx.simulatorApis.invoke(name, params)
    })
}
