import { WindowChannel } from '../../shared/ipc-channels.js'
import type { IpcContextSource } from '../utils/ipc-context-source.js'
import { IpcRegistry } from '../utils/ipc-registry.js'
import type { ProjectRef } from './project-window.js'

/**
 * Opening a project from the list — and from MCP's project_open, which the
 * list renderer forwards here — always means "give it its own window", so the
 * channel does nothing but hand the request to the workbench window manager.
 *
 * Generic over the context type: the handler never touches the context, and
 * naming it would drag `WorkbenchContext` into this module.
 */
export function registerOpenProjectWindowIpc<TCtx>(
  router: IpcContextSource<TCtx>,
  open: (project: ProjectRef) => Promise<unknown>,
): IpcRegistry<TCtx> {
  const windowIpc = new IpcRegistry<TCtx>(router)
  windowIpc.handleRouted(
    WindowChannel.OpenProjectWindow,
    async (_ctx, _event, ...args: unknown[]) => {
      const project = args[0] as ProjectRef | undefined
      if (!project?.path) throw new Error('openProjectWindow requires a project path')
      await open({ path: project.path, name: project.name })
    },
  )
  return windowIpc
}
