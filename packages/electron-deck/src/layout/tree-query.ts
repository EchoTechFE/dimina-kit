/**
 * Read-only tree queries — the single authority for locating nodes/panels in a
 * layout tree. PURE TS (types only): the mutation layer and the react renderer
 * both consume these so the same traversal is never re-implemented per caller.
 */
import type { LayoutNode, TabGroupNode } from './types.js'

/** The tab-group node with `groupId`, or null. */
export function findGroupById(root: LayoutNode, groupId: string): TabGroupNode | null {
	let found: TabGroupNode | null = null
	const walk = (n: LayoutNode): void => {
		if (found) return
		if (n.kind === 'tabs') {
			if (n.id === groupId) found = n
		}
		else {
			n.children.forEach(walk)
		}
	}
	walk(root)
	return found
}

/** The tab-group node that holds `panelId`, or null. */
export function findGroupContaining(root: LayoutNode, panelId: string): TabGroupNode | null {
	let found: TabGroupNode | null = null
	const walk = (n: LayoutNode): void => {
		if (found) return
		if (n.kind === 'tabs') {
			if (n.panels.includes(panelId)) found = n
		}
		else {
			n.children.forEach(walk)
		}
	}
	walk(root)
	return found
}

/** The id of the tab group currently holding `panelId`, or `undefined` if the
 * panel is not in the tree. Used to detect a drop back into the dragged panel's
 * own group and to guard a vanished split anchor. */
export function findPanelGroupId(root: LayoutNode, panelId: string): string | undefined {
	return findGroupContaining(root, panelId)?.id
}

/** Total panels anywhere in the tree. Drives last-panel close suppression: a
 * group view knows only its own node, so the caller computes this global count. */
export function countPanels(node: LayoutNode): number {
	if (node.kind === 'tabs') return node.panels.length
	return node.children.reduce((sum, child) => sum + countPanels(child), 0)
}
