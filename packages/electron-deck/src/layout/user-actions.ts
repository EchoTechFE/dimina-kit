/**
 * Capability-aware layout operations for user-triggered interactions.
 *
 * Keep these separate from the pure mutations: callers may still use
 * `closePanel` for restore/migration/programmatic layout transforms, while UI
 * entry points consistently honor registry capabilities.
 */
import { closePanel } from './mutations.js'
import type { LayoutTree, PanelRegistry } from './types.js'

/**
 * Close a panel only when its descriptor permits user closure.
 *
 * Missing descriptors and an omitted `closable` capability retain the historic
 * close behavior. Only an explicit `closable:false` blocks the operation.
 */
export function closePanelForUser(
	tree: LayoutTree,
	panelId: string,
	registry: PanelRegistry,
): LayoutTree {
	return registry.get(panelId)?.closable === false ? tree : closePanel(tree, panelId)
}
