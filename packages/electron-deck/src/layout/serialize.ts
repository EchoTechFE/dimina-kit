/**
 * Serialize / parse / validate — structural integrity + acyclicity. Pure TS.
 *
 * Default-DENY: parseLayout throws on any tree validateTree would flag.
 */
import type { LayoutNode, LayoutTree } from './types.js'

const MAX_DEPTH = 64

export function serializeLayout(t: LayoutTree): string {
	return JSON.stringify(t)
}

/** Mutable cross-node state threaded through the whole walk. */
interface WalkState {
	readonly seenIds: Set<string>
	readonly seenObjects: Set<object>
	readonly panelOwners: Map<string, string>
	readonly knownPanelIds: ReadonlySet<string> | null
}

/** Report missing / duplicate node id, registering the id when first seen. */
function checkNodeId(id: string | undefined, kind: unknown, state: WalkState, problems: string[]): void {
	if (id === undefined) {
		problems.push(`node missing string id (kind=${String(kind)})`)
	}
	else if (state.seenIds.has(id)) {
		problems.push(`duplicate node id: ${id}`)
	}
	else {
		state.seenIds.add(id)
	}
}

/** Validate a single panel id within a tabgroup: type, cross-group ownership, orphan. */
function checkPanel(p: unknown, id: string | undefined, state: WalkState, problems: string[]): void {
	if (typeof p !== 'string') {
		problems.push(`tabs ${id ?? '?'}: non-string panel id`)
		return
	}
	const owner = state.panelOwners.get(p)
	if (owner !== undefined) {
		problems.push(`duplicate panel id across groups: ${p}`)
	}
	else {
		state.panelOwners.set(p, id ?? '?')
	}
	if (state.knownPanelIds && !state.knownPanelIds.has(p)) {
		problems.push(`orphan panel not in known panel ids: ${p}`)
	}
}

/** Validate a `tabs` node: panels array, per-panel rules, active membership. */
function checkTabs(node: unknown, id: string | undefined, state: WalkState, problems: string[]): void {
	const tg = node as { panels?: unknown; active?: unknown }
	const panels = Array.isArray(tg.panels) ? (tg.panels as unknown[]) : null
	if (!panels) {
		problems.push(`tabs ${id ?? '?'}: panels is not an array`)
		return
	}
	if (panels.length === 0) {
		problems.push(`tabs ${id ?? '?'}: empty tabgroup`)
	}
	for (const p of panels) {
		checkPanel(p, id, state, problems)
	}
	const active = tg.active
	if (typeof active !== 'string' || !panels.includes(active)) {
		problems.push(`tabs ${id ?? '?'}: active ${String(active)} not in panels`)
	}
}

/** Validate one constraint entry. Returns true if it is PX-SIZED (non-null). */
function checkConstraintEntry(c: unknown, id: string | undefined, problems: string[]): boolean {
	if (c === null) {
		return false
	}
	if (typeof c !== 'object') {
		problems.push(`split ${id ?? '?'}: constraint is not null nor an object: ${String(c)}`)
		return false
	}
	// Exactly ONE of `fixedPx` / `minPx`, value finite > 0.
	const keys = Object.keys(c as object)
	const hasFixed = keys.includes('fixedPx')
	const hasMin = keys.includes('minPx')
	if (keys.length !== 1 || !(hasFixed || hasMin)) {
		problems.push(`split ${id ?? '?'}: constraint must have exactly one of 'fixedPx' or 'minPx', got [${keys.join(', ')}]`)
	}
	const cKey = hasFixed ? 'fixedPx' : 'minPx'
	const cVal = hasFixed ? (c as { fixedPx?: unknown }).fixedPx : (c as { minPx?: unknown }).minPx
	if (typeof cVal !== 'number' || !Number.isFinite(cVal) || cVal <= 0) {
		problems.push(`split ${id ?? '?'}: constraint ${cKey} must be a finite number > 0, got ${String(cVal)}`)
	}
	return true
}

/**
 * Validate the OPTIONAL `constraints` field's INTRINSIC format (array shape +
 * per-entry rules + exactly-one-of fixedPx/minPx + all-px guard), INDEPENDENTLY
 * of `children` validity. The LENGTH-vs-children comparison lives elsewhere.
 */
function checkConstraints(raw: unknown, id: string | undefined, problems: string[]): void {
	const constraints = Array.isArray(raw) ? (raw as unknown[]) : null
	if (!constraints) {
		problems.push(`split ${id ?? '?'}: constraints is not an array`)
		return
	}
	// Tracks whether EVERY child is PX-SIZED (a non-null constraint — `fixedPx`
	// OR `minPx`). Both are sized in px and excluded from the weight pool, so an
	// all-constrained split trips the rrp footgun (needs >= 1 weight-sized
	// child); only a `null` child clears it.
	let everyConstrained = constraints.length > 0
	for (const c of constraints) {
		if (!checkConstraintEntry(c, id, problems)) {
			everyConstrained = false
		}
	}
	// Guard the rrp footgun: an all-px-sized split has no weight-sized child to
	// absorb leftover space (rrp v4.10 requires >= 1).
	if (everyConstrained) {
		problems.push(`split ${id ?? '?'}: all children are px-sized constraints; at least one must be weight-sized`)
	}
}

/** Validate the `sizes` field against a valid `children` array. */
function checkSizes(sizes: unknown[] | null, children: unknown[], id: string | undefined, problems: string[]): void {
	if (!sizes || sizes.length !== children.length) {
		problems.push(
			`split ${id ?? '?'}: sizes ${sizes ? sizes.length : 'missing'} != children ${children.length}`,
		)
		return
	}
	for (const s of sizes) {
		if (typeof s !== 'number' || !Number.isFinite(s)) {
			problems.push(`split ${id ?? '?'}: non-finite size ${String(s)}`)
		}
	}
}

/**
 * Walk an arbitrary (possibly malformed / cyclic / shared-ref) node graph and
 * collect structural problems. Never recurses infinitely: a node already on the
 * current path (cycle) or already visited elsewhere (shared ref) is reported and
 * not descended into.
 */
function collectProblems(
	root: unknown,
	knownPanelIds: ReadonlySet<string> | null,
): string[] {
	const problems: string[] = []
	const state: WalkState = {
		seenIds: new Set<string>(),
		seenObjects: new Set<object>(),
		panelOwners: new Map<string, string>(),
		knownPanelIds,
	}

	const visit = (node: unknown, depth: number, path: Set<object>): void => {
		if (depth > MAX_DEPTH) {
			problems.push(`depth exceeds ${MAX_DEPTH}`)
			return
		}
		if (node === null || typeof node !== 'object') {
			problems.push(`node is not an object: ${String(node)}`)
			return
		}
		const obj = node as object
		if (path.has(obj)) {
			problems.push('cycle detected: node reachable from itself')
			return
		}
		if (state.seenObjects.has(obj)) {
			problems.push('shared node reference: same object appears twice')
			return
		}
		state.seenObjects.add(obj)

		const n = node as { kind?: unknown; id?: unknown }
		const kind = n.kind
		const id = typeof n.id === 'string' ? n.id : undefined

		checkNodeId(id, kind, state, problems)

		if (kind === 'tabs') {
			checkTabs(node, id, state, problems)
		}
		else if (kind === 'split') {
			visitSplit(node, id, depth, path, obj, state, problems, visit)
		}
		else {
			problems.push(`unknown node kind: ${String(kind)}`)
		}
	}

	visit(root, 0, new Set())
	return problems
}

/** Validate a `split` node and recurse into its children. */
function visitSplit(
	node: unknown,
	id: string | undefined,
	depth: number,
	path: Set<object>,
	obj: object,
	state: WalkState,
	problems: string[],
	visit: (node: unknown, depth: number, path: Set<object>) => void,
): void {
	const sp = node as { children?: unknown; sizes?: unknown; orientation?: unknown; constraints?: unknown }
	const children = Array.isArray(sp.children) ? (sp.children as unknown[]) : null
	const sizes = Array.isArray(sp.sizes) ? (sp.sizes as unknown[]) : null
	const orientation = sp.orientation
	if (orientation !== 'row' && orientation !== 'column') {
		problems.push(`split ${id ?? '?'}: invalid orientation ${String(orientation)}`)
	}
	if (sp.constraints !== undefined) {
		checkConstraints(sp.constraints, id, problems)
	}

	if (!children) {
		problems.push(`split ${id ?? '?'}: children is not an array`)
		return
	}
	if (children.length < 2) {
		problems.push(`split ${id ?? '?'}: must have >= 2 children, has ${children.length}`)
	}
	checkSizes(sizes, children, id, problems)
	// LENGTH-vs-children comparison (gated on a valid children array).
	if (sp.constraints !== undefined && Array.isArray(sp.constraints)) {
		const constraints = sp.constraints as unknown[]
		if (constraints.length !== children.length) {
			problems.push(
				`split ${id ?? '?'}: constraints ${constraints.length} != children ${children.length}`,
			)
		}
	}
	const nextPath = new Set(path)
	nextPath.add(obj)
	for (const child of children) {
		visit(child, depth + 1, nextPath)
	}
}

export function validateTree(t: LayoutTree, knownPanelIds: ReadonlySet<string>): string[] {
	if (t === null || typeof t !== 'object') return ['tree is not an object']
	if ((t as { version?: unknown }).version !== 1) {
		return [`unsupported version: ${String((t as { version?: unknown }).version)}`]
	}
	return collectProblems((t as { root?: unknown }).root, knownPanelIds)
}

export function parseLayout(json: string): LayoutTree {
	let raw: unknown
	try {
		raw = JSON.parse(json)
	}
	catch {
		throw new Error('parseLayout: input is not valid JSON')
	}
	if (raw === null || typeof raw !== 'object') {
		throw new Error('parseLayout: top-level value is not an object')
	}
	const obj = raw as { version?: unknown; root?: unknown }
	if (obj.version !== 1) {
		throw new Error(`parseLayout: unsupported version ${String(obj.version)}`)
	}
	if (obj.root === undefined || obj.root === null) {
		throw new Error('parseLayout: missing root')
	}
	// Validate structure with no knownPanelIds constraint (orphan check N/A on
	// pure deserialize — caller pairs with their own registry).
	const problems = collectProblems(obj.root, null)
	if (problems.length > 0) {
		throw new Error(`parseLayout: illegal layout — ${problems.join('; ')}`)
	}
	return { version: 1, root: obj.root as LayoutNode }
}
