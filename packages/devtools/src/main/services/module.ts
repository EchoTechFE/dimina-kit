import type { Disposable } from '../utils/disposable.js'
import type { WorkbenchContext } from './workbench-context.js'

/**
 * A composable unit of workbench functionality.
 *
 * Built-in modules (projects, session, simulator, popover, settings) are
 * implemented as `WorkbenchModule` values; hosts may also inject extra
 * modules via `WorkbenchAppConfig.extraModules`.
 *
 * `setup` is invoked once during workbench bootstrap. The returned
 * Disposable is added to `ctx.registry` so module teardown is symmetric
 * with the rest of the workbench lifecycle.
 */
export interface WorkbenchModule {
  /** Set up the module against ctx. Returns a Disposable owned by ctx.registry. */
  setup(ctx: WorkbenchContext): Disposable
}
