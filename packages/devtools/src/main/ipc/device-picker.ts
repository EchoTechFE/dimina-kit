import type { WorkbenchModule } from '../services/module.js'
import type { ViewManager } from '../services/views/view-manager.js'
import type { RendererNotifier } from '../services/notifications/renderer-notifier.js'
import { DevicePickerChannel } from '../../shared/ipc-channels-overlays.js'
import { DevicePickerDeviceSchema } from '../../shared/ipc-schemas.js'
import type { Disposable } from '@dimina-kit/electron-deck/main'
import { validate } from '../utils/ipc-schema.js'
import { IpcRegistry, type SenderPolicy } from '../utils/ipc-registry.js'
import { toIpcContextSource, type IpcInput } from '../utils/ipc-context-source.js'

/** Module-local narrow deps — deliberately NOT `Pick<WorkbenchContext, ...>`
 * (the gate in eslint.config.* is shrink-only; see its message). */
export interface DevicePickerIpcDeps {
  views: Pick<ViewManager, 'showDevicePicker' | 'hideDevicePicker'>
  notify: Pick<RendererNotifier, 'devicePickerSelected'>
  senderPolicy?: SenderPolicy
}

export function registerDevicePickerIpc(input: IpcInput<DevicePickerIpcDeps>): Disposable {
  return new IpcRegistry(toIpcContextSource(input))
    .onRouted(DevicePickerChannel.Show, (ctx, _event, ...args: unknown[]) => {
      const [data] = validate(DevicePickerChannel.Show, DevicePickerDeviceSchema, args)
      ctx.views.showDevicePicker(data)
    })
    .onRouted(DevicePickerChannel.Cancel, (ctx) => {
      ctx.views.hideDevicePicker()
    })
    .onRouted(DevicePickerChannel.Select, (ctx, _event, ...args: unknown[]) => {
      const [data] = validate(DevicePickerChannel.Select, DevicePickerDeviceSchema, args)
      ctx.views.hideDevicePicker()
      ctx.notify.devicePickerSelected(data)
    })
  // OverlayChannel.Ready is registered once, in tooltip.ts — every overlay
  // renderer (this one included) funnels readiness through that single
  // listener, so a second registration here would double-fire markOverlayReady.
}

export const devicePickerModule: WorkbenchModule = {
  setup: (ctx) => registerDevicePickerIpc(ctx),
}
