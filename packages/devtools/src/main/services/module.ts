import type { Disposable } from '@dimina-kit/electron-deck/main'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
import type { WorkbenchContext } from './workbench-context.js'
import type { IpcContextSource } from '../utils/ipc-context-source.js'

/**
 * A composable unit of workbench functionality.
 *
 * Built-in modules (projects, session, simulator, popover, settings) are
 * implemented as `WorkbenchModule` values.
 *
 * The two hooks differ in what they own. `setup` registers IPC once for the
 * application and answers each message with the context the sender belongs to,
 * so its handlers must read everything from that argument. `setupWindow` is the
 * escape hatch for wiring that genuinely belongs to a single window — it
 * receives that window's concrete context and may mutate it.
 *
 * Both returned Disposables are added to a registry so module teardown is
 * symmetric with the rest of the workbench lifecycle.
 */
export interface WorkbenchModule {
  /** Register the module's IPC against every live window context. */
  setup(source: IpcContextSource<WorkbenchContext>): Disposable
  /** Optional per-window wiring, run once for each window that opens. */
  setupWindow?(ctx: WorkbenchContext): Disposable
}
