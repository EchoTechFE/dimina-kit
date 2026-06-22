/**
 * Shared test fixtures + tiny structural helpers for the layout test-suite.
 * NOT part of the public surface. Pure data + traversal — no electron/react.
 */
import type { LayoutNode, LayoutTree, SplitNode, TabGroupNode } from './types.js'

export function tabs(id: string, panels: string[], active?: string): TabGroupNode {
	return { kind: 'tabs', id, panels, active: active ?? panels[0]! }
}

export function split(
	id: string,
	orientation: 'row' | 'column',
	children: LayoutNode[],
	sizes?: number[],
): SplitNode {
	return {
		kind: 'split',
		id,
		orientation,
		children,
		sizes: sizes ?? children.map(() => 1),
	}
}

export function tree(root: LayoutNode): LayoutTree {
	return { version: 1, root }
}

/** Depth-first list of every node. */
export function allNodes(t: LayoutTree): LayoutNode[] {
	const out: LayoutNode[] = []
	const walk = (n: LayoutNode): void => {
		out.push(n)
		if (n.kind === 'split') n.children.forEach(walk)
	}
	walk(t.root)
	return out
}

export function findGroup(t: LayoutTree, id: string): TabGroupNode | undefined {
	return allNodes(t).find((n): n is TabGroupNode => n.kind === 'tabs' && n.id === id)
}

export function findSplit(t: LayoutTree, id: string): SplitNode | undefined {
	return allNodes(t).find((n): n is SplitNode => n.kind === 'split' && n.id === id)
}

/** The group currently containing `panelId`, if any. */
export function groupOf(t: LayoutTree, panelId: string): TabGroupNode | undefined {
	return allNodes(t).find(
		(n): n is TabGroupNode => n.kind === 'tabs' && n.panels.includes(panelId),
	)
}

/** Every panelId present in the tree (in DFS / tab order). */
export function allPanels(t: LayoutTree): string[] {
	const out: string[] = []
	for (const n of allNodes(t)) {
		if (n.kind === 'tabs') out.push(...n.panels)
	}
	return out
}

/**
 * Assert that `fn` throws a REAL domain error — i.e. it actually rejected the
 * input, not merely a `not-implemented` stub. The implementation must throw a
 * meaningful error, not 'not-implemented'. This prevents `.toThrow()` from
 * false-greening against a bare skeleton.
 */
export function expectRejects(fn: () => unknown): void {
	let thrown: unknown
	let didThrow = false
	try {
		fn()
	}
	catch (e) {
		didThrow = true
		thrown = e
	}
	if (!didThrow) {
		throw new Error('expected the call to throw, but it returned normally')
	}
	const msg = thrown instanceof Error ? thrown.message : String(thrown)
	if (msg === 'not-implemented') {
		throw new Error('still hitting the not-implemented stub — expected a real domain rejection')
	}
}

/**
 * Structural-invariant assertions that must hold after ANY mutation.
 * Returns a list of problems ([] = ok). Used by the mutation tests to prove
 * collapse + sizes/active invariants without trusting the engine's own
 * validateTree.
 */
export function structuralProblems(t: LayoutTree): string[] {
	const problems: string[] = []
	for (const n of allNodes(t)) {
		if (n.kind === 'split') {
			if (n.sizes.length !== n.children.length) {
				problems.push(`split ${n.id}: sizes ${n.sizes.length} != children ${n.children.length}`)
			}
			if (n.children.length < 2) {
				problems.push(`split ${n.id}: must have >= 2 children, has ${n.children.length}`)
			}
		}
		else {
			if (n.panels.length === 0) {
				problems.push(`tabs ${n.id}: empty`)
			}
			if (!n.panels.includes(n.active)) {
				problems.push(`tabs ${n.id}: active ${n.active} not in panels`)
			}
		}
	}
	return problems
}
