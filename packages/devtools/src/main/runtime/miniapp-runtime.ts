/**
 * MiniappRuntime — the stable, host-facing contract surface (foundation.md §3
 * "MiniappRuntime 契约" layer, P4).
 *
 * `WorkbenchContext` is the rich internal main-process state: runtime kernel +
 * host config + trust/infra plumbing, all mixed. Downstream hosts (qdmp, a
 * re-skin of devtools that depends ONLY on devtools) don't consume that whole
 * grab-bag — they drive the miniapp KERNEL: the view lifecycle (including the
 * host-controllable toolbar at `views.hostToolbar`), the cross-wc bridge, the
 * workspace, the custom-API registry, async storage, the appdata tap, the
 * connection layer, and the main→renderer notifier.
 *
 * This module NAMES that kernel as an explicit, documented contract so the
 * surface a host depends on is compiler-enforced and versionable, instead of
 * "whatever fields of WorkbenchContext you happen to reach for". Config inputs
 * (appName / panels / apiNamespaces / branding / project templates) are the
 * host's INPUT, not part of the runtime it consumes; trust/infra
 * (senderPolicy / trustedWindowSenderIds / registry / toolbar action-table)
 * stay internal.
 *
 * Derived via `Pick<WorkbenchContext, …>` so the field TYPES never drift from
 * the real implementation — `MiniappRuntime` is a view onto `WorkbenchContext`,
 * and the conformance assertion below fails to compile the moment the context
 * stops satisfying the contract.
 *
 * The host-controllable toolbar WebContentsView hangs off `views.hostToolbar`
 * (a ViewManager concern), so it's reachable through the contract WITHOUT a 9th
 * top-level member — `runtime.views.hostToolbar.loadURL(...)`.
 */
import type { WorkbenchContext } from '../services/workbench-context.js'

/** The stable miniapp-kernel surface a downstream host (qdmp) consumes. */
export type MiniappRuntime = Pick<
  WorkbenchContext,
  | 'views'
  | 'bridge'
  | 'workspace'
  | 'simulatorApis'
  | 'storageApi'
  | 'appData'
  | 'connections'
  | 'notify'
>

/**
 * Project a full `WorkbenchContext` down to its `MiniappRuntime` view. Hosts
 * call this to get a value typed to exactly the contract — no wider access to
 * the context's internals leaks through.
 */
export function asMiniappRuntime(ctx: WorkbenchContext): MiniappRuntime {
  return ctx
}

/**
 * Compile-time conformance guard: if `WorkbenchContext` ever stops structurally
 * satisfying `MiniappRuntime` (a kernel field renamed / its type narrowed),
 * THIS line fails `tsc`, catching the contract break at build time. The runtime
 * value is unused.
 */
const _conformance: (ctx: WorkbenchContext) => MiniappRuntime = (ctx) => ctx
void _conformance
