import type { WorkbenchModule } from '../services/module.js'
import type { ViewManager } from '../services/views/view-manager.js'
import type { RendererNotifier } from '../services/notifications/renderer-notifier.js'
import { ProjectCreateChannel } from '../../shared/ipc-channels-overlays.js'
import { ProjectCreateShowSchema, ProjectCreateSubmitSchema } from '../../shared/ipc-schemas.js'
import type { Disposable } from '@dimina-kit/electron-deck/main'
import { validate } from '../utils/ipc-schema.js'
import { IpcRegistry, type SenderPolicy } from '../utils/ipc-registry.js'

/** Module-local narrow deps — deliberately NOT `Pick<WorkbenchContext, ...>`
 * (the gate in eslint.config.* is shrink-only; see its message). */
export interface ProjectCreateIpcDeps {
  views: Pick<ViewManager, 'showProjectCreateDialog' | 'hideProjectCreateDialog'>
  notify: Pick<RendererNotifier, 'projectCreateSubmitted'>
  senderPolicy?: SenderPolicy
}

export function registerProjectCreateIpc(ctx: ProjectCreateIpcDeps): Disposable {
  return new IpcRegistry(ctx.senderPolicy)
    .on(ProjectCreateChannel.Show, (_event, ...args: unknown[]) => {
      const [data] = validate(ProjectCreateChannel.Show, ProjectCreateShowSchema, args)
      ctx.views.showProjectCreateDialog(data)
    })
    .on(ProjectCreateChannel.Cancel, () => {
      ctx.views.hideProjectCreateDialog()
    })
    .on(ProjectCreateChannel.Submit, (_event, ...args: unknown[]) => {
      const [input] = validate(ProjectCreateChannel.Submit, ProjectCreateSubmitSchema, args)
      ctx.views.hideProjectCreateDialog()
      ctx.notify.projectCreateSubmitted(input)
    })
  // OverlayChannel.Ready is registered once, in tooltip.ts — every overlay
  // renderer (this one included) funnels readiness through that single
  // listener, so a second registration here would double-fire markOverlayReady.
}

export const projectCreateModule: WorkbenchModule = {
  setup: (ctx) => registerProjectCreateIpc(ctx),
}
