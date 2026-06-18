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
	const seenIds = new Set<string>()
	const seenObjects = new Set<object>()
	const panelOwners = new Map<string, string>()

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
		if (seenObjects.has(obj)) {
			problems.push('shared node reference: same object appears twice')
			return
		}
		seenObjects.add(obj)

		const n = node as { kind?: unknown; id?: unknown }
		const kind = n.kind
		const id = typeof n.id === 'string' ? n.id : undefined

		if (id === undefined) {
			problems.push(`node missing string id (kind=${String(kind)})`)
		}
		else if (seenIds.has(id)) {
			problems.push(`duplicate node id: ${id}`)
		}
		else {
			seenIds.add(id)
		}

		if (kind === 'tabs') {
			const tg = node as { panels?: unknown; active?: unknown }
			const panels = Array.isArray(tg.panels) ? (tg.panels as unknown[]) : null
			if (!panels) {
				problems.push(`tabs ${id ?? '?'}: panels is not an array`)
			}
			else {
				if (panels.length === 0) {
					problems.push(`tabs ${id ?? '?'}: empty tabgroup`)
				}
				for (const p of panels) {
					if (typeof p !== 'string') {
						problems.push(`tabs ${id ?? '?'}: non-string panel id`)
						continue
					}
					const owner = panelOwners.get(p)
					if (owner !== undefined) {
						problems.push(`duplicate panel id across groups: ${p}`)
					}
					else {
						panelOwners.set(p, id ?? '?')
					}
					if (knownPanelIds && !knownPanelIds.has(p)) {
						problems.push(`orphan panel not in known panel ids: ${p}`)
					}
				}
				const active = tg.active
				if (typeof active !== 'string' || !panels.includes(active)) {
					problems.push(`tabs ${id ?? '?'}: active ${String(active)} not in panels`)
				}
			}
		}
		else if (kind === 'split') {
			const sp = node as { children?: unknown; sizes?: unknown; orientation?: unknown; constraints?: unknown }
			const children = Array.isArray(sp.children) ? (sp.children as unknown[]) : null
			const sizes = Array.isArray(sp.sizes) ? (sp.sizes as unknown[]) : null
			const orientation = sp.orientation
			if (orientation !== 'row' && orientation !== 'column') {
				problems.push(`split ${id ?? '?'}: invalid orientation ${String(orientation)}`)
			}
			// OPTIONAL constraints — validate the field's INTRINSIC format (array
			// shape + per-entry rules + exactly-one-of fixedPx/minPx + all-FIXED
			// guard) INDEPENDENTLY of `children` validity. Only the LENGTH-vs-children
			// comparison is gated on `children` being a valid array (done below).
			if (sp.constraints !== undefined) {
				const constraints = Array.isArray(sp.constraints) ? (sp.constraints as unknown[]) : null
				if (!constraints) {
					problems.push(`split ${id ?? '?'}: constraints is not an array`)
				}
				else {
					// Tracks whether EVERY child is PX-SIZED (a non-null constraint —
					// `fixedPx` OR `minPx`). Both are sized in px and excluded from the
					// weight pool, so an all-constrained split trips the rrp footgun
					// (needs >= 1 weight-sized child); only a `null` child clears it.
					let everyConstrained = constraints.length > 0
					for (const c of constraints) {
						if (c === null) {
							everyConstrained = false
							continue
						}
						if (typeof c !== 'object') {
							everyConstrained = false
							problems.push(`split ${id ?? '?'}: constraint is not null nor an object: ${String(c)}`)
							continue
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
					}
					// Guard the rrp footgun: an all-px-sized split has no weight-sized
					// child to absorb leftover space (rrp v4.10 requires >= 1).
					if (everyConstrained) {
						problems.push(`split ${id ?? '?'}: all children are px-sized constraints; at least one must be weight-sized`)
					}
				}
			}

			if (!children) {
				problems.push(`split ${id ?? '?'}: children is not an array`)
			}
			else {
				if (children.length < 2) {
					problems.push(`split ${id ?? '?'}: must have >= 2 children, has ${children.length}`)
				}
				if (!sizes || sizes.length !== children.length) {
					problems.push(
						`split ${id ?? '?'}: sizes ${sizes ? sizes.length : 'missing'} != children ${children.length}`,
					)
				}
				else {
					for (const s of sizes) {
						if (typeof s !== 'number' || !Number.isFinite(s)) {
							problems.push(`split ${id ?? '?'}: non-finite size ${String(s)}`)
						}
					}
				}
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
		}
		else {
			problems.push(`unknown node kind: ${String(kind)}`)
		}
	}

	visit(root, 0, new Set())
	return problems
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
