/**
 * Pure tree mutations. Every function returns a NEW tree and never mutates its
 * input (clone-on-write). All structural invariants (#1) are funnelled through
 * `normalizeRoot`, which collapses empty tabgroups + single-child splits,
 * cascading upward, while keeping the root a LayoutNode.
 */
import type { LayoutNode, LayoutTree, Orientation, SizeConstraint, SplitNode, TabGroupNode } from './types.js'
import { findGroupById, findGroupContaining } from './tree-query.js'

// ───────────────────────── helpers ─────────────────────────

function tg(id: string, panels: string[], active: string): TabGroupNode {
	return { kind: 'tabs', id, panels, active }
}

/** Re-derive active after panels changed: keep current active if still present,
 * else select panels[min(removedIndex, len-1)] (clamp to last). */
function deriveActive(panels: string[], prevActive: string, removedIndex: number): string {
	if (panels.length === 0) return ''
	if (panels.includes(prevActive)) return prevActive
	const idx = Math.min(removedIndex, panels.length - 1)
	return panels[Math.max(0, idx)]!
}

/**
 * Collapse a (already child-normalized) node:
 *  - tabgroup with 0 panels => null (drop)
 *  - split: drop null children; if 0 left => null; if 1 left => that child;
 *    else rebuild with repaired sizes.
 */
function normalize(node: LayoutNode): LayoutNode | null {
	if (node.kind === 'tabs') {
		return node.panels.length === 0 ? null : node
	}
	// split: normalize children first.
	const kept: LayoutNode[] = []
	const keptSizes: number[] = []
	const keptConstraints: (SizeConstraint | null)[] = []
	const hadConstraints = node.constraints !== undefined
	node.children.forEach((child, i) => {
		const n = normalize(child)
		if (n !== null) {
			kept.push(n)
			keptSizes.push(node.sizes[i] ?? 1)
			if (hadConstraints) keptConstraints.push(node.constraints![i] ?? null)
		}
	})
	if (kept.length === 0) return null
	if (kept.length === 1) return kept[0]!
	const rebuilt: SplitNode = { kind: 'split', id: node.id, orientation: node.orientation, children: kept, sizes: keptSizes }
	if (!hadConstraints) return rebuilt
	// M3 repair: dropping children can leave a multi-child split whose survivors
	// are ALL px-sized (`fixedPx` or `minPx` — the sole flexible/`null` child was
	// the one removed). That tree is rejected by validateTree (rrp needs >= 1
	// weight-sized child). Deterministically clear the LAST survivor's constraint
	// so >= 1 flexible child remains.
	const allFixed = keptConstraints.length > 0 && !keptConstraints.some(c => c === null)
	if (allFixed) {
		keptConstraints[keptConstraints.length - 1] = null
	}
	return { ...rebuilt, constraints: keptConstraints }
}

/** Apply collapse to the root, guaranteeing the result is a LayoutNode. A root
 * that collapses to nothing is illegal upstream (we never empty the last group
 * without a replacement), so we only reach here with a survivor. */
function normalizeRoot(root: LayoutNode): LayoutNode {
	const n = normalize(root)
	if (n === null) {
		throw new Error('mutation would empty the entire layout')
	}
	return n
}

/** Collect every panelId present anywhere in the tree. */
function collectPanelIds(root: LayoutNode): Set<string> {
	const out = new Set<string>()
	const walk = (n: LayoutNode): void => {
		if (n.kind === 'tabs') {
			for (const p of n.panels) out.add(p)
		}
		else {
			n.children.forEach(walk)
		}
	}
	walk(root)
	return out
}

/** True if `panelId` exists in any tabgroup of the tree. */
function hasPanel(root: LayoutNode, id: string): boolean {
	return collectPanelIds(root).has(id)
}

/** Collect every node id present anywhere in the tree (splits + tabgroups). */
function collectNodeIds(root: LayoutNode): Set<string> {
	const out = new Set<string>()
	const walk = (n: LayoutNode): void => {
		out.add(n.id)
		if (n.kind === 'split') n.children.forEach(walk)
	}
	walk(root)
	return out
}

/**
 * Mint an id from `base` that is not already in `taken`. If `base` is free,
 * return it; otherwise append an incrementing `#N` suffix until free. Mutates
 * `taken` so successive calls in the same mutation can't collide with each other.
 */
function freshId(taken: Set<string>, base: string): string {
	let candidate = base
	let n = 2
	while (taken.has(candidate)) {
		candidate = `${base}#${n}`
		n += 1
	}
	taken.add(candidate)
	return candidate
}

function findSplitById(root: LayoutNode, splitId: string): SplitNode | null {
	let found: SplitNode | null = null
	const walk = (n: LayoutNode): void => {
		if (found) return
		if (n.kind === 'split') {
			if (n.id === splitId) found = n
			n.children.forEach(walk)
		}
	}
	walk(root)
	return found
}

/**
 * Rebuild the tree, replacing the node with matching id by `replacement`
 * (which may be null to delete — handled by collapse). This produces a fresh
 * object graph (clone-on-write); untouched branches are still rebuilt so the
 * input is never shared.
 */
function replaceNode(node: LayoutNode, targetId: string, replacement: LayoutNode): LayoutNode {
	if (node.id === targetId) return replacement
	if (node.kind === 'tabs') return tg(node.id, [...node.panels], node.active)
	const out: SplitNode = {
		kind: 'split',
		id: node.id,
		orientation: node.orientation,
		children: node.children.map(c => replaceNode(c, targetId, replacement)),
		sizes: [...node.sizes],
	}
	return node.constraints !== undefined ? { ...out, constraints: [...node.constraints] } : out
}

function cloneNode(node: LayoutNode): LayoutNode {
	if (node.kind === 'tabs') return tg(node.id, [...node.panels], node.active)
	const out: SplitNode = {
		kind: 'split',
		id: node.id,
		orientation: node.orientation,
		children: node.children.map(cloneNode),
		sizes: [...node.sizes],
	}
	return node.constraints !== undefined ? { ...out, constraints: [...node.constraints] } : out
}

function wrap(root: LayoutNode): LayoutTree {
	return { version: 1, root }
}

// ───────────────────────── mutations ─────────────────────────

export function setSizes(t: LayoutTree, splitId: string, sizes: readonly number[]): LayoutTree {
	const target = findSplitById(t.root, splitId)
	if (!target) throw new Error(`setSizes: split not found: ${splitId}`)
	if (sizes.length !== target.children.length) {
		throw new Error(
			`setSizes: sizes length ${sizes.length} != children length ${target.children.length}`,
		)
	}
	if (!sizes.every(s => Number.isFinite(s))) {
		throw new Error(`setSizes: every size must be a finite number, got [${sizes.join(', ')}]`)
	}
	const replacement: SplitNode = {
		kind: 'split',
		id: target.id,
		orientation: target.orientation,
		children: target.children.map(cloneNode),
		sizes: [...sizes],
	}
	// setSizes must NOT touch constraints — carry them through unchanged.
	const withConstraints: SplitNode = target.constraints !== undefined
		? { ...replacement, constraints: [...target.constraints] }
		: replacement
	return wrap(replaceNode(t.root, splitId, withConstraints))
}

/**
 * Set (or clear) the fixed-px constraint on child `childIndex` of split
 * `splitId`. Pure (clone-on-write). Lazily materializes an all-null constraints
 * array aligned with `children` when absent, then writes the slot. Clearing
 * (`constraint === null`) keeps the array even if all entries become null.
 */
export function setConstraint(
	t: LayoutTree,
	splitId: string,
	childIndex: number,
	constraint: SizeConstraint | null,
): LayoutTree {
	const target = findSplitById(t.root, splitId)
	if (!target) throw new Error(`setConstraint: split not found: ${splitId}`)
	if (!Number.isInteger(childIndex)) {
		throw new Error(`setConstraint: childIndex must be an integer, got ${childIndex}`)
	}
	if (childIndex < 0 || childIndex >= target.children.length) {
		throw new Error(
			`setConstraint: childIndex ${childIndex} out of range [0, ${target.children.length})`,
		)
	}
	const base: (SizeConstraint | null)[] = target.constraints !== undefined
		? [...target.constraints]
		: target.children.map(() => null)
	base[childIndex] = constraint
	// M3 guard: never produce an all-px-sized split. `fixedPx` and `minPx` both
	// count as "constrained" here (the check is `c !== null`, not a `fixedPx`
	// check), so setting EITHER kind of constraint on the LAST unconstrained
	// child is a NO-OP: it would leave 0 weight-sized children, and
	// `validateTree`/`parseLayout` later rejects a fully px-sized split (rrp
	// requires >= 1 weight-sized child).
	if (base.length > 0 && base.every(c => c !== null)) {
		return t
	}
	const replacement: SplitNode = {
		kind: 'split',
		id: target.id,
		orientation: target.orientation,
		children: target.children.map(cloneNode),
		sizes: [...target.sizes],
		constraints: base,
	}
	return wrap(replaceNode(t.root, splitId, replacement))
}

export function setActive(t: LayoutTree, groupId: string, panelId: string): LayoutTree {
	const group = findGroupById(t.root, groupId)
	if (!group) throw new Error(`setActive: group not found: ${groupId}`)
	if (!group.panels.includes(panelId)) {
		throw new Error(`setActive: panel ${panelId} not in group ${groupId}`)
	}
	const replacement = tg(group.id, [...group.panels], panelId)
	return wrap(replaceNode(t.root, groupId, replacement))
}

/** Remove a panel from whichever group holds it; collapse. */
function removePanel(root: LayoutNode, panelId: string): LayoutNode {
	const group = findGroupContaining(root, panelId)
	if (!group) throw new Error(`panel not found: ${panelId}`)
	const removedIndex = group.panels.indexOf(panelId)
	const panels = group.panels.filter(p => p !== panelId)
	const replacement = tg(group.id, panels, deriveActive(panels, group.active, removedIndex))
	const replaced = replaceNode(root, group.id, replacement)
	return normalizeRoot(replaced)
}

export function closePanel(t: LayoutTree, panelId: string): LayoutTree {
	// Last-panel no-op guard: closing the SOLE panel in the whole tree would
	// empty the layout (normalizeRoot throws). Instead return the tree unchanged
	// so hosts can wire a close button without special-casing the final panel.
	// An UNKNOWN id is NOT "the last panel" — only short-circuit when the panel
	// actually EXISTS and is the only one; otherwise fall through to removePanel,
	// which throws "panel not found" for an unknown id (behavior preserved).
	const ids = collectPanelIds(t.root)
	if (ids.size === 1 && ids.has(panelId)) return t
	return wrap(removePanel(t.root, panelId))
}

export function extractPanel(
	t: LayoutTree,
	panelId: string,
): { tree: LayoutTree; extracted: string } {
	const group = findGroupContaining(t.root, panelId)
	if (!group) throw new Error(`extractPanel: panel not found: ${panelId}`)
	return { tree: wrap(removePanel(t.root, panelId)), extracted: panelId }
}

export function insertPanel(
	t: LayoutTree,
	panelId: string,
	dest: { groupId: string; index?: number },
): LayoutTree {
	if (hasPanel(t.root, panelId)) {
		throw new Error(`insertPanel: panel already exists in the tree: ${panelId}`)
	}
	const group = findGroupById(t.root, dest.groupId)
	if (!group) throw new Error(`insertPanel: dest group not found: ${dest.groupId}`)
	const panels = [...group.panels]
	const idx = clampInsertIndex(dest.index, panels.length)
	panels.splice(idx, 0, panelId)
	const replacement = tg(group.id, panels, group.active)
	return wrap(normalizeRoot(replaceNode(t.root, group.id, replacement)))
}

function clampInsertIndex(index: number | undefined, len: number): number {
	if (index === undefined) return len
	if (index < 0) return 0
	if (index > len) return len
	return index
}

export function movePanel(
	t: LayoutTree,
	panelId: string,
	dest: { groupId: string; index?: number },
): LayoutTree {
	const srcGroup = findGroupContaining(t.root, panelId)
	if (!srcGroup) throw new Error(`movePanel: panel not found: ${panelId}`)
	const destGroup = findGroupById(t.root, dest.groupId)
	if (!destGroup) throw new Error(`movePanel: dest group not found: ${dest.groupId}`)

	if (srcGroup.id === destGroup.id) {
		// Same-group reorder: remove then re-insert at the clamped index.
		const without = srcGroup.panels.filter(p => p !== panelId)
		const idx = clampInsertIndex(dest.index, without.length)
		const panels = [...without]
		panels.splice(idx, 0, panelId)
		const replacement = tg(srcGroup.id, panels, srcGroup.active)
		return wrap(normalizeRoot(replaceNode(t.root, srcGroup.id, replacement)))
	}

	// Cross-group: remove from source (re-derive active + maybe collapse), then
	// insert into dest. Compute the destination panels against the ORIGINAL dest
	// group so the clamp matches its pre-move length.
	const removedIndex = srcGroup.panels.indexOf(panelId)
	const srcPanels = srcGroup.panels.filter(p => p !== panelId)
	const srcReplacement = tg(srcGroup.id, srcPanels, deriveActive(srcPanels, srcGroup.active, removedIndex))

	const destPanels = [...destGroup.panels]
	const idx = clampInsertIndex(dest.index, destPanels.length)
	destPanels.splice(idx, 0, panelId)
	const destReplacement = tg(destGroup.id, destPanels, destGroup.active)

	let root = replaceNode(t.root, srcGroup.id, srcReplacement)
	root = replaceNode(root, destGroup.id, destReplacement)
	return wrap(normalizeRoot(root))
}

/**
 * Wrap the CURRENT ENTIRE tree as one side of a brand-new top-level split, with
 * `newPanelId` (in its own fresh single-panel group) as the other side. Unlike
 * `splitPanel` — which carves the new panel into whichever single panel's own
 * slot it targets, so that panel now shares its slot 50/50 with the new one —
 * this makes the new panel a peer of EVERYTHING already in the tree, regardless
 * of that tree's internal shape (row, column, or arbitrarily nested).
 *
 * Use for panels whose home position is "beside the rest of the layout as a
 * whole" (e.g. re-showing a hidden simulator column that must sit alongside
 * editor + debug together, not nested inside just one of them). Splitting into
 * a single sibling's slot instead of the whole tree is what let a `minPx` floor
 * on the new panel consume that one sibling's entire (already-narrower) slot,
 * squeezing it to zero rendered width.
 */
export function wrapRoot(
	t: LayoutTree,
	newPanelId: string,
	dir: Orientation,
	side: 'before' | 'after',
): LayoutTree {
	if (hasPanel(t.root, newPanelId)) {
		throw new Error(`wrapRoot: new panel already exists in the tree: ${newPanelId}`)
	}
	const taken = collectNodeIds(t.root)
	const rootId = t.root.id
	const newGroup = tg(freshId(taken, `${rootId}__new`), [newPanelId], newPanelId)
	const rest = cloneNode(t.root)
	const children: LayoutNode[] = side === 'after' ? [rest, newGroup] : [newGroup, rest]
	const newSplit: SplitNode = {
		kind: 'split',
		id: freshId(taken, `${rootId}__wrap`),
		orientation: dir,
		children,
		sizes: [1, 1],
	}
	return wrap(newSplit)
}

/**
 * Split at the position of an EXISTING group, keeping ALL of its panels
 * together as one side and a brand-new single-panel group as the other side.
 *
 * Unlike `splitPanel` — which resolves its anchor through a single PANEL id
 * and, when that panel's group holds more than one panel, only extracts that
 * one member (leaving its siblings behind in the original group) — this takes
 * a GROUP id directly and never touches the group's contents. Use it when the
 * new panel's home is "beside this specific region as a whole" (e.g. the
 * editor reopening beside the multi-tab debug region): resolving that through
 * `splitPanel` against one of the region's tabs would sever that one tab from
 * its siblings into its own group, exactly the failure `wrapRoot` fixed for
 * "beside the whole tree" — this is the same fix scoped to one known group
 * instead of the root, since wrapping the whole tree would also drag in
 * siblings the caller never meant to move (e.g. the simulator column).
 */
export function splitGroup(
	t: LayoutTree,
	groupId: string,
	dir: Orientation,
	newPanelId: string,
	side: 'before' | 'after',
): LayoutTree {
	if (hasPanel(t.root, newPanelId)) {
		throw new Error(`splitGroup: new panel already exists in the tree: ${newPanelId}`)
	}
	const group = findGroupById(t.root, groupId)
	if (!group) throw new Error(`splitGroup: group not found: ${groupId}`)

	const taken = collectNodeIds(t.root)
	const newGroup = tg(freshId(taken, `${groupId}__new`), [newPanelId], newPanelId)
	const origGroup = cloneNode(group)
	const children: LayoutNode[] = side === 'after' ? [origGroup, newGroup] : [newGroup, origGroup]
	const newSplit: SplitNode = {
		kind: 'split',
		id: freshId(taken, `${groupId}__sp`),
		orientation: dir,
		children,
		sizes: [1, 1],
	}
	return wrap(normalizeRoot(replaceNode(t.root, groupId, newSplit)))
}

export function splitPanel(
	t: LayoutTree,
	atPanelId: string,
	dir: Orientation,
	newPanelId: string,
	side: 'before' | 'after',
): LayoutTree {
	if (hasPanel(t.root, newPanelId)) {
		throw new Error(`splitPanel: new panel already exists in the tree: ${newPanelId}`)
	}
	const group = findGroupContaining(t.root, atPanelId)
	if (!group) throw new Error(`splitPanel: panel not found: ${atPanelId}`)

	// Generated node ids must be unique within the current tree: a node literally
	// named `${origGroupId}__sp` could already exist and produce a duplicate-id
	// tree. Mint collision-free ids off the deterministic bases.
	const taken = collectNodeIds(t.root)

	// Extract atPanelId into its own new group.
	const origGroupId = group.id
	const extractedGroup = tg(freshId(taken, `${origGroupId}__split`), [atPanelId], atPanelId)
	const newGroup = tg(freshId(taken, `${origGroupId}__new`), [newPanelId], newPanelId)

	const children: LayoutNode[] = side === 'after'
		? [extractedGroup, newGroup]
		: [newGroup, extractedGroup]
	const newSplit: SplitNode = {
		kind: 'split',
		id: freshId(taken, `${origGroupId}__sp`),
		orientation: dir,
		children,
		sizes: [1, 1],
	}

	if (group.panels.length === 1) {
		// Replace the whole group with the new split.
		return wrap(normalizeRoot(replaceNode(t.root, origGroupId, newSplit)))
	}

	// Multi-panel group: pull atPanelId out, keep the rest in the orig group,
	// and place the new split where the orig group was... but the orig group must
	// survive too. So: replace orig group with a split [remainingGroup, newSplit]?
	// The contract only requires: atPanel + newPanel live in different groups, and
	// the orig group keeps the remaining panels. Replace orig group with a split
	// of [origRemaining, newSplit] using `dir` orientation.
	const removedIndex = group.panels.indexOf(atPanelId)
	const remaining = group.panels.filter(p => p !== atPanelId)
	const origRemainingGroup = tg(origGroupId, remaining, deriveActive(remaining, group.active, removedIndex))

	const outerChildren: LayoutNode[] = side === 'after'
		? [origRemainingGroup, newSplit]
		: [newSplit, origRemainingGroup]
	const outerSplit: SplitNode = {
		kind: 'split',
		id: freshId(taken, `${origGroupId}__outer`),
		orientation: dir,
		children: outerChildren,
		sizes: [1, 1],
	}
	return wrap(normalizeRoot(replaceNode(t.root, origGroupId, outerSplit)))
}
