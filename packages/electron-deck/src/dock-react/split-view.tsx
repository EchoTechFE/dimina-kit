/**
 * `SplitView` — one split node rendered as a react-resizable-panels Group, plus
 * the model↔view sync machine (M1): it pushes the model's flexible weights into
 * the live Group via `setLayout` and writes a genuine user resize back through
 * `ctx.onApplyLayout`. The split-sizing arithmetic lives in `./split-sizing`.
 */
import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import type { GroupImperativeHandle, Layout } from 'react-resizable-panels'
import type { LayoutNode, SplitNode } from '../layout/index.js'
import {
	buildSetLayoutMap,
	clampFlexibleWeights,
	computeFlexiblePercentages,
	FLEX_RATIO_TOLERANCE,
	flexibleFloor,
	incomingFlexRatios,
	layoutsEquivalent,
} from './split-sizing.js'
import { renderNode, type RenderContext } from './dock-view.js'

/** A split wrapper element augmented with the resize write-back seam plus the
 * rrp Group imperative handle (M1 model→view sync). Hosts/tests reach the live
 * split layout through `__deckGroupApi` the same way they reach the write-back
 * through `__deckApplyLayout`. */
type DeckSplitElement = HTMLDivElement & {
	__deckApplyLayout?: (weights: number[]) => void
	__deckGroupApi?: GroupImperativeHandle
}

export interface SplitViewProps {
	node: SplitNode
	ctx: RenderContext
}

export function SplitView(props: SplitViewProps): ReactNode {
	const { node, ctx } = props
	const orientation = node.orientation === 'row' ? 'horizontal' : 'vertical'

	// A child is FIXED (px-pinned) iff it carries a non-null constraint. Fixed
	// children are excluded from the flexible-percentage pool: their px panel does
	// not participate in weight-based sizing, so polluting `toPercentages` with
	// their weight would skew the flexible siblings' defaultSize.
	// `computeFlexiblePercentages` therefore normalizes percentages over the
	// FLEXIBLE indices only and maps them back by index; fixed children keep their
	// px defaultSize/min/max. (Both write-back seams derive fixed-ness from
	// `nodeRef.current.constraints` directly — see `handleLayoutChanged` and
	// `__deckApplyLayout` — so no render-closure `isFixed` helper is needed here.)
	const percentageByIndex = computeFlexiblePercentages(node.sizes, node.constraints)

	// Bug #1 defense A: the minimum % a flexible child may shrink to. rrp's default
	// flexible `minSize` is 0% (a panel can be dragged to nothing); this floors it
	// so the simulator/editor can never be pulled to 0 width. Unitless string =
	// percentage (same convention as `defaultSize` above; a px `minSize` next to a
	// %-`defaultSize` is misparsed by rrp). The floor is keyed on the COUNT of
	// flexible children in THIS split (the same value the write-back clamp uses).
	const flexCount = node.children.filter((_, i) => (node.constraints?.[i] ?? null) === null).length
	const flexMinSize = String(flexibleFloor(flexCount))

	// ── M1 model→view sync plumbing ────────────────────────────────────────
	// The rrp Group's imperative handle (getLayout/setLayout) — the seam through
	// which the model becomes the source of truth for the visible split ratio.
	const groupRef = useRef<GroupImperativeHandle | null>(null)
	// The split's own wrapper element — read for its REAL measured pixel size
	// (Bug #3 defense, see `runSync`). Set by `setSplitRef` alongside the other
	// imperative seams on the same element.
	const containerElRef = useRef<HTMLDivElement | null>(null)
	// Keep the latest node reachable from the imperative ref + drag callbacks
	// without re-binding the ref on every render. The sync effect reads the
	// freshest `node` directly (it re-runs when `node.sizes` change), so it does
	// not go stale; this ref is for the imperative seams that capture once.
	const nodeRef = useRef(node)
	nodeRef.current = node

	const items: ReactNode[] = []
	node.children.forEach((child, i) => {
		if (i > 0) {
			items.push(
				<Separator
					key={`handle-${i}`}
					data-deck-resize-handle=""
				/>,
			)
		}
		// PIXEL-sized children (`fixedPx`/`minPx`) are sized in px, NOT weights, so
		// they are excluded from the flexible % pool (`computeFlexiblePercentages`)
		// and never normalized against weight-sized siblings. rrp needs CONSISTENT
		// units per panel — a px `minSize` on a %-`defaultSize` panel is misparsed
		// (the panel grabs the whole region), so a px floor MUST pair with a px
		// `defaultSize`.
		const constraint = node.constraints?.[i] ?? null
		if (constraint?.fixedPx != null) {
			// `fixedPx` LOCKS the child: min===max + `preserve-pixel-size` keeps it
			// fixed while flexible siblings absorb group resizes.
			const px = `${constraint.fixedPx}px`
			items.push(
				<Panel
					key={panelKey(child)}
					id={child.id}
					defaultSize={px}
					minSize={px}
					maxSize={px}
					groupResizeBehavior="preserve-pixel-size"
				>
					{renderNode(child, ctx)}
				</Panel>,
			)
		}
		else if (constraint?.minPx != null) {
			// `minPx` FLOORS the child at a pixel minimum but leaves it DRAGGABLE
			// above it: px `defaultSize`+`minSize` (starts AT the floor, can't shrink
			// past it), NO `maxSize` so the user can widen it. `preserve-pixel-size`
			// puts the panel in rrp's pixel mode — WITHOUT it rrp misparses a px
			// `defaultSize` next to %-sized siblings and the panel grabs ~80% of the
			// region. It only governs WINDOW-resize behavior (keep pixel width, don't
			// scale); the user can still drag the separator to resize it (≥ minSize).
			const px = `${constraint.minPx}px`
			items.push(
				<Panel
					key={panelKey(child)}
					id={child.id}
					defaultSize={px}
					minSize={px}
					groupResizeBehavior="preserve-pixel-size"
				>
					{renderNode(child, ctx)}
				</Panel>,
			)
		}
		else {
			// `defaultSize` seeds the FLEXIBLE child at mount; post-mount the model
			// becomes the source of truth via the imperative `setLayout` driven from
			// the sync effect below (M1). The value is passed as a STRING percentage:
			// rrp treats a NUMBER `defaultSize` as PIXELS, so `defaultSize={70}` would
			// be 70px (not 70%) — which mis-proportions a flexible sibling next to a
			// px-sized (`fixedPx`/`minPx`) panel and the sync then preserves the wrong
			// size. A unitless string is parsed as a percentage.
			const pct = percentageByIndex.get(i)
			items.push(
				<Panel
					key={panelKey(child)}
					id={child.id}
					defaultSize={pct != null ? String(pct) : undefined}
					minSize={flexMinSize}
				>
					{renderNode(child, ctx)}
				</Panel>,
			)
		}
	})

	// A real rrp resize (pointer OR keyboard) — or our own `setLayout` echo / a
	// spontaneous re-measure — commits new per-Panel percentages here. The SINGLE
	// discriminator is a BASIS-NORMALIZED flexible-ratio compare (no gate, no echo
	// token): write back IFF the incoming layout's FLEXIBLE-child ratios differ from
	// the model's. `incomingFlexRatios` normalizes rrp's CONTAINER-% over the
	// flexible subset; `computeFlexiblePercentages` already does the same for the
	// model — so both bases sum to 100 and are directly comparable.
	const handleLayoutChanged = (layout: Layout): void => {
		const cur = nodeRef.current
		const curChildIds = cur.children.map((c) => c.id)
		const isFixedAt = (i: number): boolean => (cur.constraints?.[i] ?? null) !== null

		const incoming = incomingFlexRatios(curChildIds, cur.constraints, layout)
		if (!incoming) return // malformed / no flexible child → never write back
		const modelPctByIndex = computeFlexiblePercentages(cur.sizes, cur.constraints)
		const modelNorm = incoming.indices.map((i) => modelPctByIndex.get(i) ?? 0)

		// Equal within a TIGHT tolerance → our own `setLayout` echo OR a
		// ratio-preserving spontaneous re-measure (mount / fixed-px re-pin / container
		// resize). SKIP: no model churn, no loop, no R2 corruption. Otherwise it is a
		// genuine user resize → WRITE BACK.
		const differs = incoming.ratios.some(
			(r, k) => Math.abs(r - modelNorm[k]!) > FLEX_RATIO_TOLERANCE,
		)
		if (!differs) return

		// FULL-LENGTH weights (setSizes requires length === children.length). FIXED
		// children keep the model's existing weight — rrp reports a container-derived %
		// for the pinned panel which, written back, would corrupt the stored weight and
		// lose it when the constraint is later cleared. FLEXIBLE children take rrp's.
		const weights = curChildIds.map((id, i) =>
			isFixedAt(i) ? cur.sizes[i] ?? 1 : layout[id]!,
		)
		// Bug #1 defense B: a flexible child dragged to ~0 width reports a ~0 ratio;
		// floor it before persisting so a 0-width weight can never reach the model
		// (the rrp `minSize` from A is the first defense, this is the write-back
		// backstop). Px children are untouched (clampFlexibleWeights skips them).
		ctx.onApplyLayout(cur.id, clampFlexibleWeights(weights, cur.constraints))
	}

	// Ref callback exposing the resize write-back seam + the rrp Group imperative
	// handle on the split element. A drag round-trip (e2e) and the unit seam both
	// land on the same engine path; the `__deckGroupApi` handle lets hosts/tests
	// read the LIVE split layout (M1 model→view sync seam).
	const setSplitRef = (el: DeckSplitElement | null): void => {
		containerElRef.current = el
		if (el) {
			el.__deckApplyLayout = (weights: number[]) => {
				// Mirror handleLayoutChanged: a fixed child's stored weight is never
				// overwritten by an incoming (container-derived) value — preserve
				// node.sizes[i] for fixed indices so clearing the constraint later
				// restores the original weight. Flexible indices take the supplied value.
				// Derive fixed-ness from `nodeRef.current.constraints` (the SAME fresh
				// node we read sizes from) so this seam has no fresh-sizes/stale-constraints
				// asymmetry. Mirrors `isFixedAt` in handleLayoutChanged.
				const cur = nodeRef.current
				const isFixedAt = (i: number): boolean => (cur.constraints?.[i] ?? null) !== null
				const next = weights.map((w, i) => (isFixedAt(i) ? cur.sizes[i] ?? 1 : w))
				// Bug #1 defense B (same clamp as handleLayoutChanged): floor flexible
				// weights so a near-0 drag can never persist a 0-width panel.
				ctx.onApplyLayout(cur.id, clampFlexibleWeights(next, cur.constraints))
			}
			// Expose the rrp Group imperative handle (getLayout/setLayout) so a host —
			// and the jsdom `[M1-seam-live]` test — can reach the live split layout.
			// May be null until the Group mounts its handle; the getter reads the
			// freshest ref each call.
			Object.defineProperty(el, '__deckGroupApi', {
				configurable: true,
				get: () => groupRef.current ?? undefined,
			})
		}
	}

	// ── M1 model→view sync ─────────────────────────────────────────────────
	// Push the model's FLEXIBLE weights into the live Group via `setLayout` so the
	// model is the source of truth for the visible split post-mount (without it rrp
	// freezes at the mount-time `defaultSize`). Reads the FRESHEST `node` from the
	// ref so an external `setSizes` syncs against the latest model.
	//
	// `isFreshRemount` is `true` exactly once per Group instance — the first sync
	// right after it mounted (see the `childCountKey` effect below). Bug #3 defense:
	// when a `minPx`/`fixedPx` child's content is itself a NESTED split, rrp's
	// mount-time px→percentage conversion for that child can land on a degenerate
	// ratio (observed: the pinned child grabbing ~99% while its lone flexible
	// sibling collapses to rrp's floor) — and because nothing ever re-measures
	// afterward, that wrong `live` value would otherwise be trusted and
	// perpetuated forever. On this first sync we instead derive the fixed child's
	// target percentage from a REAL measurement of the split's own container
	// (`containerElRef`), bypassing rrp's untrustworthy live value. Every
	// subsequent sync (`isFreshRemount: false`) keeps trusting `live` for a
	// `minPx` child, since the user may have legitimately dragged it wider than
	// its floor by then — see `MeasuredContainer`.
	//
	// Returns `stuck: true` when nothing needed pushing OR the push is confirmed
	// (by re-reading `getLayout()`) to have taken hold — `false` when rrp is not
	// ready yet (`groupRef` unpopulated) or SILENTLY CLAMPED our push back to a
	// stale constraint (empirically: right after a fresh mount, rrp's own
	// `derivedPanelConstraints` for the nested-split pinned child can still
	// reflect the same bad initial measurement, and `validatePanelGroupLayout`
	// rejects a legitimate corrective value against it — the constraint only
	// self-corrects once rrp's ResizeObserver re-measures on a LATER frame). The
	// `childCountKey` effect below retries (bounded) on `stuck: false`.
	const runSync = useCallback((isFreshRemount: boolean): { pushed: boolean; stuck: boolean } => {
		const api = groupRef.current
		if (!api) return { pushed: false, stuck: false }
		const cur = nodeRef.current
		const curChildIds = cur.children.map((c) => c.id)

		const live = api.getLayout()
		const containerEl = containerElRef.current
		const containerRect = containerEl?.getBoundingClientRect()
		const containerPx = containerRect
			? (cur.orientation === 'row' ? containerRect.width : containerRect.height)
			: 0
		const measured = containerPx > 0 ? { containerPx, trustLiveForMinPx: !isFreshRemount } : undefined
		// jsdom's stub returns `{}` (no measured geometry) and a 0 `getBoundingClientRect`
		// — `measured` is then `undefined` and `buildSetLayoutMap` falls back to its
		// live-trusting behavior, which in turn returns null for any fixed child; but
		// `setLayout` is a no-op under jsdom anyway. In a real renderer both are populated.
		const targetMap = buildSetLayoutMap(curChildIds, cur.sizes, cur.constraints, live, measured)
		if (!targetMap) return { pushed: false, stuck: false }

		// SET-side redundant-push skip: don't re-push a layout the live Group already
		// satisfies. This is the loop break on the SET side — pushing an identical
		// layout would re-emit `onLayoutChanged`, but its flexible ratios match the
		// model so the normalized compare in `handleLayoutChanged` skips the write-back
		// anyway; this skip just avoids the redundant work.
		if (layoutsEquivalent(live, targetMap, curChildIds)) return { pushed: false, stuck: true }

		api.setLayout(targetMap)
		// Confirm the push actually stuck — rrp's `setLayout` validates the
		// incoming layout against its OWN panel constraints and silently clamps
		// anything that violates them (see the doc comment above).
		const stuck = layoutsEquivalent(api.getLayout(), targetMap, curChildIds)
		return { pushed: true, stuck }
	}, [])

	// Re-run the sync whenever the model's raw weights change (every external
	// `setSizes`). The model is stable DURING a user drag — the write-back lands on
	// release — so this effect does not fire mid-drag and never fights the live
	// pointer snapshot. An external `setSizes` (incl. one after an away-and-back
	// drag) syncs immediately (R3): there is no drag flag to get stuck.
	const sizesKey = node.sizes.join(',')
	// Child COUNT is part of the sync key (Bug #2 follow-up): the `key={children.
	// length}` on the Group remounts it on a cardinality change, and a remount
	// reseeds the rrp layout from each Panel's `defaultSize` — for a `minPx` column
	// that is the floor (the device-min), NOT the user's last-dragged width. Re-
	// running `runSync` after the remount re-pushes the model's stored weights into
	// the fresh Group so a surviving split's proportions are restored rather than
	// snapping back to the per-Panel defaults. A pure weight resize (same count)
	// already re-syncs via `sizesKey`; this only adds the count edge.
	const childCountKey = node.children.length
	// Tracks the child count as of the LAST sync, so this render can tell whether
	// the Group instance behind `groupRef` is the one that was already synced
	// (an ordinary weight change) or a brand new one (`key={node.children.length}`
	// just remounted it, or this is the very first mount — seeded `null` so the
	// initial sync is ALSO treated as fresh, covering a session that restores
	// straight into a shape prone to Bug #3, e.g. `belowSimulator`).
	const prevChildCountKeyRef = useRef<number | null>(null)
	// Bug #3 defense (continued from `runSync`'s doc comment): an ordinary
	// (non-remount) sync sticks synchronously today — pinned so this fix does
	// not add latency to that already-working path. A FRESH remount's push can
	// get silently clamped by a stale rrp constraint that only self-corrects a
	// couple of animation frames later; retry (bounded, empirically converges
	// within 2 frames) until `runSync` confirms the push stuck, rather than
	// hard-coding an exact frame count that could be too short on a slower host.
	const MAX_FRESH_REMOUNT_SYNC_ATTEMPTS = 8
	useEffect(() => {
		const isFreshRemount = prevChildCountKeyRef.current !== childCountKey
		prevChildCountKeyRef.current = childCountKey

		if (!isFreshRemount) {
			runSync(false)
			return
		}

		let cancelled = false
		let rafId = 0
		let attempts = 0
		const tick = (): void => {
			if (cancelled) return
			attempts += 1
			const { stuck } = runSync(true)
			if (!stuck && attempts < MAX_FRESH_REMOUNT_SYNC_ATTEMPTS) {
				rafId = requestAnimationFrame(tick)
			}
		}
		rafId = requestAnimationFrame(tick)
		return () => {
			cancelled = true
			cancelAnimationFrame(rafId)
		}
		// Keyed on `sizesKey` + `childCountKey`; `runSync` reads `node`/`childIds`/
		// `constraints` fresh from the ref, so they cannot go stale relative to either.
	}, [sizesKey, childCountKey, runSync])

	// The split-level `data-*` attributes ride on an outer wrapper rather than
	// the Group itself, so hosts/tests can target them regardless of how the
	// library forwards unknown props. `data-deck-sizes` mirrors the model's
	// CURRENT raw weights so the render is a function of model.sizes.
	return (
		<div
			ref={setSplitRef}
			data-deck-split={node.id}
			data-orientation={node.orientation}
			data-deck-sizes={node.sizes.join(',')}
			style={{ width: '100%', height: '100%' }}
		>
			<Group
				// Bug #2 (white-screen crash guard): KEY the Group on its child COUNT.
				// rrp v4.10 caches the previous layout in a ref keyed by group id; on a
				// render where the child count CHANGES (a panel closed/split — the split
				// id stays 'root' so the Group instance is otherwise reused), rrp's
				// commit-phase layout effect synchronously validates the STALE
				// (old-length) cached layout against the NEW (different-length)
				// constraints and throws `Invalid N panel layout`. That throw escapes
				// SplitView during commit and unmounts the whole tree (white screen).
				// Keying on `node.children.length` remounts the Group with a fresh
				// internal layout sized to the new child count ONLY when the count
				// changes — an ordinary weight resize never changes the key, so this
				// adds NO remount on drags. The model→view sync (runSync) re-binds
				// `groupRef` on remount and re-pushes the model's weights via the
				// `sizesKey` effect; the simulator/console native overlay re-anchors via
				// its slot ref callback (same path as a tab switch). See
				// dock-view-robustness.test.tsx "3 → 2" for the regression.
				key={node.children.length}
				groupRef={groupRef}
				orientation={orientation}
				onLayoutChanged={handleLayoutChanged}
				style={{ width: '100%', height: '100%' }}
			>
				{items}
			</Group>
		</div>
	)
}

/** Stable React key for a child node (split id or group id). */
function panelKey(node: LayoutNode): string {
	return node.id
}
