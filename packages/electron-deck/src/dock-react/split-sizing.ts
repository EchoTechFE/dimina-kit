/**
 * Pure split-sizing math for the dock renderer — no react import.
 *
 * These functions translate between the model's raw per-child WEIGHTS (+ px
 * constraints) and the percentage/ratio bases the react-resizable-panels Group
 * consumes and reports. They are the single arithmetic authority behind
 * `SplitView`'s model→view sync and resize write-back; several are exported so
 * the sizing invariants can be unit-tested directly.
 */
import type { SizeConstraint } from '../layout/index.js'

/** Epsilon (in percentage points) within which two split layouts are treated as
 * equivalent. Guards BOTH sides of the model↔view loop: we skip pushing a
 * `setLayout` when the live layout already matches the target, and skip the
 * `onLayoutChanged` write-back when the incoming layout matches the model — so
 * `setLayout`→`onLayoutChanged`→write-back→re-sync cannot loop. */
export const LAYOUT_EPSILON = 0.5

/** TIGHT tolerance (percentage points) for the BASIS-NORMALIZED flexible-ratio
 * compare in `handleLayoutChanged`. We normalize the incoming layout's flexible
 * subset to ratios summing to 100 and compare them against the model's flexible
 * ratios (`computeFlexiblePercentages`, also summing to 100). If they match
 * within this tolerance the `onLayoutChanged` is either our own `setLayout` echo
 * OR a ratio-preserving spontaneous re-measure (mount / fixed-px re-pin /
 * container resize) — SKIP the write-back. If they differ it is a genuine user
 * resize (pointer OR keyboard) — WRITE BACK.
 *
 * Set to ~0.1pp: large enough to absorb rrp's ~3-decimal float noise on an echo,
 * yet FAR below a real drag's delta. R1's "sub-0.5%" drag moves a panel ~0.33pp
 * of the container; normalized over the two-flexible-child subset that is ~0.66pp
 * of ratio — comfortably above 0.1, so it is NOT mistaken for an echo and is
 * written back.
 *
 * CAVEAT: this is a flexible-RATIO tolerance (the flexible subset normalized to
 * sum 100), NOT a container-%. It is safe against rrp's 3-decimal echo noise.
 * In a pathologically WIDE split (~≥10 flexible children) a single arrow-key
 * nudge (±~5% of the container on one child) can, once normalized over many
 * flexible siblings, fall BELOW 0.1pp of ratio and be skipped — exotic and
 * self-healing (the next, larger resize writes back). If that ever matters,
 * scale the tolerance down by the flexible child count. */
export const FLEX_RATIO_TOLERANCE = 0.1

/** Normalize raw split weights to percentages summing ~100 for `defaultSize`. */
export function toPercentages(sizes: readonly number[]): number[] {
	const total = sizes.reduce((a, b) => a + (b > 0 ? b : 0), 0)
	if (total <= 0) {
		// Degenerate weights → distribute evenly.
		const even = sizes.length > 0 ? 100 / sizes.length : 100
		return sizes.map(() => even)
	}
	return sizes.map((s) => ((s > 0 ? s : 0) / total) * 100)
}

/**
 * Compute the `defaultSize` percentage for each FLEXIBLE child, keyed by its
 * ORIGINAL child index. Px-sized children (a non-null `constraint` — `fixedPx`
 * locked OR `minPx` floored) are EXCLUDED from the pool: their size is px, not a
 * weight, so it must never pollute the flexible siblings' normalization (FIX E1).
 * `constraints[i]` non-null ⇒ child i is px-sized and absent from the returned map.
 */
export function computeFlexiblePercentages(
	sizes: readonly number[],
	constraints: readonly (SizeConstraint | null)[] | undefined,
): Map<number, number> {
	const flexibleIndices = sizes
		.map((_, i) => i)
		.filter((i) => (constraints?.[i] ?? null) === null)
	const pct = toPercentages(flexibleIndices.map((i) => sizes[i] ?? 0))
	const out = new Map<number, number>()
	flexibleIndices.forEach((origIndex, j) => {
		out.set(origIndex, pct[j]!)
	})
	return out
}

/**
 * The minimum weight a FLEXIBLE child may hold, given how many flexible children
 * share the split (Bug #1). A flexible `<Panel>` has no rrp `minSize` by default
 * (rrp floor is 0%), so a user can drag it to ~0 width; the resize write-back
 * would then persist a ~0 weight and the panel comes back invisible/stuck.
 *
 * The floor is `min(1, floor(90 / flexCount))` — i.e. ~1 weight unit (a flexible
 * split's weights are normalized to percentages downstream, so ~1 reads as ~1%
 * of the flexible pool). With any realistic flexible count this is exactly 1; the
 * `min(1, …)` only matters for a hypothetical 90+ flexible-child split. It is the
 * SAME value used for the rrp `minSize` (A) and the write-back clamp (B) so the
 * two defenses never disagree.
 */
export function flexibleFloor(flexCount: number): number {
	// `floor(90 / flexCount)` is ~1 for any realistic count, but goes to 0 once
	// flexCount > 90 — which would silently DEFEAT the floor (a 0 minSize / 0 clamp
	// is no floor at all). Clamp into [MIN_POSITIVE_FLOOR, 1] so the floor is always
	// a positive percentage even in a pathologically wide split.
	const MIN_POSITIVE_FLOOR = 0.5
	return Math.min(1, Math.max(MIN_POSITIVE_FLOOR, Math.floor(90 / Math.max(1, flexCount))))
}

/**
 * Clamp the FLEXIBLE entries of a full-length weights array up to `floor` (Bug #1
 * defense B). Px-sized children (a non-null constraint) are left untouched — their
 * `sizes[i]` is a preserved placeholder, not a live weight. Returns a new array;
 * a weight already ≥ floor is kept verbatim so a healthy ratio is undisturbed.
 */
export function clampFlexibleWeights(
	weights: readonly number[],
	constraints: readonly (SizeConstraint | null)[] | undefined,
): number[] {
	const flexCount = weights.filter((_, i) => (constraints?.[i] ?? null) === null).length
	const floor = flexibleFloor(flexCount)
	return weights.map((w, i) => {
		if ((constraints?.[i] ?? null) !== null) return w // px child — leave as-is
		return Number.isFinite(w) && w >= floor ? w : floor
	})
}

/** Are two panelId→percentage maps equivalent within `epsilon` percentage
 * points? Both maps must cover EXACTLY the `ids` key set — a missing key OR an
 * extra key (a key present in `a`/`b` but absent from `ids`) counts as NOT
 * equivalent so the sync is not falsely suppressed. A non-finite value
 * (NaN/±Infinity) is likewise NOT equivalent — `typeof NaN === 'number'` and
 * `Math.abs(NaN - x) > eps` is `false`, so without the `Number.isFinite` guard a
 * NaN would slip through as "equivalent" and wrongly suppress a legitimate
 * sync/write-back (N1). EXPORTED (pure) for direct unit coverage. */
export function layoutsEquivalent(
	a: Record<string, number>,
	b: Record<string, number>,
	ids: readonly string[],
	epsilon: number = LAYOUT_EPSILON,
): boolean {
	// Exact key-set match: any key in `a` or `b` that is not in `ids` (extra key)
	// makes the maps non-equivalent. `ids` is the authoritative compared set.
	const idSet = new Set(ids)
	for (const k of Object.keys(a)) if (!idSet.has(k)) return false
	for (const k of Object.keys(b)) if (!idSet.has(k)) return false
	for (const id of ids) {
		const av = a[id]
		const bv = b[id]
		if (!Number.isFinite(av) || !Number.isFinite(bv)) return false
		if (Math.abs((av as number) - (bv as number)) > epsilon) return false
	}
	return true
}

/**
 * A real measurement of the split's container, along its layout axis (width
 * for a `row` split, height for `column`) — the ONLY reliable source for a
 * px-constrained child's target percentage right after a fresh Group mount,
 * when rrp has not yet established a trustworthy live layout for it (see
 * `buildSetLayoutMap`).
 */
export interface MeasuredContainer {
	/** Real measured pixel size of the split's container. */
	containerPx: number
	/**
	 * Whether a `minPx` child's CURRENT live percentage should be trusted over
	 * recomputing it from `constraint.minPx`. `minPx` is a FLOOR, not a lock —
	 * the user may have legitimately dragged it wider, and an ONGOING sync
	 * (this flag `true`) must not snap that back down to the floor. Only the
	 * FIRST sync after a fresh Group remount (this flag `false`) has no such
	 * history to preserve, so the floor is authoritative there. `fixedPx`
	 * children are unaffected by this flag — a locked child is always computed
	 * from the measurement, in both cases.
	 */
	trustLiveForMinPx: boolean
}

/**
 * Build the panel-ID→PERCENTAGE map for an imperative `setLayout`, given the
 * model's full-length raw `sizes` (per child) and `constraints`:
 *
 *  - FIXED (px-pinned) children normally keep their CURRENT measured
 *    percentage (read from the live `getLayout()`) — they are NOT derived
 *    from weights, so a flexible-weights change never disturbs their pixel
 *    lock. When `measured` is supplied, a `fixedPx` child is instead always
 *    computed from the real container size (it never legitimately differs
 *    from its exact px value), and a `minPx` child is too, but ONLY when
 *    `measured.trustLiveForMinPx` is `false` — see `MeasuredContainer`. This
 *    matters because right after `<Group>` cold-mounts a `minPx`/`fixedPx`
 *    child whose content is itself a NESTED split, rrp's own mount-time
 *    px→percentage conversion for that child can land on a degenerate ratio
 *    (observed: a pinned child grabbing ~99% while its lone flexible sibling
 *    collapses to rrp's floor) — the live layout it reports is simply wrong,
 *    and blindly trusting it would perpetuate the collapse forever (there is
 *    no subsequent event that would ever correct it).
 *  - The REMAINING percentage (100 − Σ fixed%) is distributed across the
 *    FLEXIBLE children in proportion to their weights.
 *
 * Returns `null` when the map can't be built faithfully (e.g. `live` is empty —
 * jsdom's stub — or a fixed child's live % is missing and no `measured`
 * fallback applies), so the caller skips the `setLayout` rather than pushing a
 * corrupt total. The result always sums to ~100 over all children.
 */
export function buildSetLayoutMap(
	childIds: readonly string[],
	sizes: readonly number[],
	constraints: readonly (SizeConstraint | null)[] | undefined,
	live: Record<string, number>,
	measured?: MeasuredContainer,
): Record<string, number> | null {
	const isFixedAt = (i: number): boolean => (constraints?.[i] ?? null) !== null

	// The target percentage for a FIXED (px-constrained) child at index `i`.
	// Prefers a direct px→percentage computation from a real measurement over
	// trusting rrp's live-reported value — see the doc comment above for why.
	const fixedPercentAt = (i: number): number | null => {
		const constraint = constraints?.[i] ?? null
		if (measured && measured.containerPx > 0 && constraint) {
			if (constraint.fixedPx != null) {
				return (constraint.fixedPx / measured.containerPx) * 100
			}
			if (constraint.minPx != null && !measured.trustLiveForMinPx) {
				return (constraint.minPx / measured.containerPx) * 100
			}
		}
		const livePct = live[childIds[i]!]
		return typeof livePct === 'number' ? livePct : null
	}

	const fixedTotal = sumFixedPercent(childIds, isFixedAt, fixedPercentAt)
	// Without a usable percentage for a fixed child we cannot build a faithful
	// map — bail so we don't corrupt the fixed child.
	if (fixedTotal === null) return null

	const remaining = Math.max(0, 100 - fixedTotal)

	// Flexible weight pool.
	let flexWeightTotal = 0
	let flexibleCount = 0
	for (let i = 0; i < childIds.length; i++) {
		if (isFixedAt(i)) continue
		const w = sizes[i] ?? 0
		flexWeightTotal += w > 0 ? w : 0
		flexibleCount += 1
	}

	const out: Record<string, number> = {}
	for (let i = 0; i < childIds.length; i++) {
		const id = childIds[i]!
		out[id] = isFixedAt(i)
			? fixedPercentAt(i)!
			: flexibleShare(sizes[i] ?? 0, remaining, flexWeightTotal, flexibleCount)
	}
	return out
}

/**
 * Sum the fixed children's target percentages (via `fixedPercentAt`). Null
 * when any fixed child has no usable percentage — the caller cannot build a
 * faithful map then.
 */
function sumFixedPercent(
	childIds: readonly string[],
	isFixedAt: (i: number) => boolean,
	fixedPercentAt: (i: number) => number | null,
): number | null {
	let fixedTotal = 0
	for (let i = 0; i < childIds.length; i++) {
		if (!isFixedAt(i)) continue
		const pct = fixedPercentAt(i)
		if (pct === null) return null
		fixedTotal += pct
	}
	return fixedTotal
}

/**
 * One flexible child's percentage share of the `remaining` space. A degenerate
 * weight pool (total ≤ 0) splits the remaining space evenly instead.
 */
function flexibleShare(
	weight: number,
	remaining: number,
	flexWeightTotal: number,
	flexibleCount: number,
): number {
	if (flexWeightTotal <= 0) {
		return flexibleCount > 0 ? remaining / flexibleCount : remaining
	}
	return (remaining * (weight > 0 ? weight : 0)) / flexWeightTotal
}

/**
 * Extract an rrp `onLayoutChanged` map's FLEXIBLE subset (skipping fixed-px
 * children) in child order and NORMALIZE it by its own sum to ratios summing to
 * ~100 — the basis `computeFlexiblePercentages` already produces for the model,
 * so the two are directly comparable. Returns the original child `indices`
 * alongside the `ratios`. Null when the map is malformed (a flexible id is
 * missing / non-finite) or there is no flexible child — the caller then never
 * writes back from it.
 */
export function incomingFlexRatios(
	childIds: readonly string[],
	constraints: readonly (SizeConstraint | null)[] | undefined,
	layout: Record<string, number>,
): { indices: number[]; ratios: number[] } | null {
	const indices: number[] = []
	const raw: number[] = []
	for (let i = 0; i < childIds.length; i++) {
		if ((constraints?.[i] ?? null) !== null) continue
		const v = layout[childIds[i]!]
		if (typeof v !== 'number' || !Number.isFinite(v)) return null
		indices.push(i)
		raw.push(v > 0 ? v : 0)
	}
	if (indices.length === 0) return null
	return { indices, ratios: toPercentages(raw) }
}
