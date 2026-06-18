/**
 * Self-healing for persisted layout trees — pure TS (no react/electron).
 *
 * A FLEXIBLE child (`constraints[i]` null / no constraints) has no enforced
 * lower weight bound in the serialized tree: `validateTree` only rejects
 * NON-FINITE sizes, not non-positive ones. A user who dragged a flexible panel
 * to ~0 width writes a ~0 (or 0, or negative) weight into the tree; on the next
 * restore that panel comes back at 0 width, invisible and effectively stuck.
 *
 * `sanitizeFlexibleWeights` heals such a tree: every flexible child whose weight
 * is NON-POSITIVE (≤ 0 or non-finite) is lifted to a minimum positive weight, so
 * a restored panel is always visible. A small-but-POSITIVE weight is left as-is
 * — weights are a relative ratio (any positive scale is valid), so a tiny
 * positive weight is healthy, not collapsed. PX-SIZED children
 * (`fixedPx`/`minPx`) are sized in pixels, NOT weights — their `sizes[i]` entry
 * is a preserved-but-unused placeholder — so they are left untouched. The
 * function is pure (clone-on-write, never mutates the input).
 */
import type { LayoutNode, LayoutTree, SizeConstraint, SplitNode } from './types.js'

/** The healed-up value for a collapsed flexible child. A small positive weight:
 * enough to make the panel visible without stealing meaningful space from its
 * healthy siblings (the user can re-drag afterwards). */
const HEALED_FLEX_WEIGHT = 1

/** Is child `i` of `node` flexible (weight-sized) — i.e. has no px constraint? */
function isFlexibleAt(node: SplitNode, i: number): boolean {
	return (node.constraints?.[i] ?? null) === null
}

function sanitizeNode(node: LayoutNode): LayoutNode {
	if (node.kind === 'tabs') return node

	// Recurse first so nested splits are healed regardless of this level.
	const children = node.children.map(sanitizeNode)

	// Heal this split's FLEXIBLE child weights. ONLY a NON-POSITIVE weight (≤ 0 or
	// non-finite — the "dragged to 0 / negative" collapse) is healed; every
	// POSITIVE weight is kept verbatim, however small. Weights are a RELATIVE ratio
	// (any positive scale is valid — `[0.001, 0.006]` is the same layout as
	// `[1, 6]`), so a small-but-positive weight is healthy and must not be rewritten
	// (that would crush the ratio). Px children are never touched.
	let changed = children.some((c, i) => c !== node.children[i])
	const sizes = node.sizes.map((w, i) => {
		if (!isFlexibleAt(node, i)) return w
		if (typeof w === 'number' && Number.isFinite(w) && w > 0) return w
		changed = true
		return HEALED_FLEX_WEIGHT
	})

	if (!changed) return node
	const rebuilt: SplitNode = {
		kind: 'split',
		id: node.id,
		orientation: node.orientation,
		children,
		sizes,
	}
	// Preserve the constraints array verbatim (only weights are touched).
	return node.constraints !== undefined
		? { ...rebuilt, constraints: node.constraints as readonly (SizeConstraint | null)[] }
		: rebuilt
}

/**
 * Return a tree in which every FLEXIBLE child with a non-positive (≤ tiny
 * threshold) weight is healed to a minimum positive weight, recursively. Px
 * children are untouched. Pure: the input is never mutated; a fully-healthy tree
 * is returned structurally unchanged (same weights).
 */
export function sanitizeFlexibleWeights(tree: LayoutTree): LayoutTree {
	const root = sanitizeNode(tree.root)
	return root === tree.root ? tree : { version: 1, root }
}
