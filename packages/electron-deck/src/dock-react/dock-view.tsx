/**
 * `<DockView>` — React renderer for a layout-as-data tree.
 *
 * Pure function of the current model snapshot (+ registry + the two host
 * callbacks). It owns NO layout state: it subscribes to the `LayoutModel`,
 * keeps the latest tree in component state, and re-renders on every emission.
 * All structural targeting is via STABLE `data-*` attributes — see the
 * contract doc-block in `dock-view.test.tsx`.
 *
 * This file lives under `src/dock-react/` (NOT `src/layout/`), so importing
 * react here does not violate the pure-TS layout boundary.
 */
import {
	createContext,
	Fragment,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
	type DragEvent,
	type ReactNode,
} from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import type { GroupImperativeHandle, Layout } from 'react-resizable-panels'
import { closePanel, extractPanel, movePanel, setActive, setSizes, splitPanel } from '../layout/index.js'
import type {
	LayoutModel,
	LayoutNode,
	LayoutTree,
	PanelRegistry,
	SizeConstraint,
	SplitNode,
	TabGroupNode,
} from '../layout/index.js'
import {
	computeDropZone,
	computeReorderIndex,
	dropZoneToMutation,
	isNoopRedock,
	type DropZone,
} from './drag-redock.js'

/**
 * The dataTransfer MIME under which a drag carries the dragged panel id. A
 * custom type (vs `text/plain`) keeps deck drags from being confused with
 * arbitrary text drops; the panel id also stays recoverable from the source
 * tab's `data-deck-tab` attribute (the jsdom seam relies on the latter).
 */
const DRAG_PANEL_MIME = 'application/x-deck-panel'

export interface DockViewProps {
	model: LayoutModel
	registry: PanelRegistry
	/**
	 * Render a DOM panel's body. `opts.active` is `true` iff `panelId` is its tab
	 * group's currently-active panel. Under DOM-panel keepalive every DOM panel in
	 * a group is rendered (the inactive ones hidden), so this callback is invoked
	 * for ALL of them and `opts.active` is RE-EVALUATED on every activation change
	 * WITHOUT remounting the kept-alive subtree — letting a host run on-activation
	 * side effects (e.g. data refresh) off the false→true `active` edge.
	 */
	renderDomPanel: (panelId: string, opts: { active: boolean }) => ReactNode
	bindNativeSlot: (panelId: string, el: HTMLElement | null) => void
}

/**
 * The current layout EPOCH — the model's revision, bumped once per committed
 * mutation. `DockView` provides it; descendant panels read it via
 * `useDockLayoutEpoch`.
 *
 * Its reason to exist: a native-view overlay anchored inside a dock panel
 * (a `WebContentsView` tracking its slot's geometry) re-publishes its bounds
 * only on GEOMETRY events (ResizeObserver / window-resize / splitter-drag). A
 * layout mutation that REORDERS a slot without resizing it — flipping a
 * fixed-width simulator column left↔right, moving a region — produces NO such
 * event (a same-size flex reorder fires nothing), so the overlay would freeze
 * at its old position. The epoch is the layout layer's explicit "something
 * moved" signal: a panel hosting a native overlay re-measures (e.g. pulses its
 * view-anchor) when the epoch changes, catching the translate the browser never
 * reports. Default 0 (outside a provider): the consuming effect runs once on
 * mount, which is harmless.
 */
const LayoutEpochContext = createContext<number>(0)

/**
 * Read the current dock layout epoch (the model revision). Re-renders the caller
 * whenever a layout mutation commits. Keyed into a panel's effect deps, it lets
 * a native-overlay host re-measure on a reorder that fires no geometry event.
 * Returns 0 when used outside a `<DockView>`.
 */
export function useDockLayoutEpoch(): number {
	return useContext(LayoutEpochContext)
}

/** Normalize raw split weights to percentages summing ~100 for `defaultSize`. */
function toPercentages(sizes: readonly number[]): number[] {
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

export function DockView(props: DockViewProps): ReactNode {
	const { model, registry, renderDomPanel, bindNativeSlot } = props

	// Snapshot the canonical tree; re-render on every external emission. The
	// `epoch` mirrors the model revision (0 before the first apply) and is
	// provided to descendant panels via `LayoutEpochContext` so a native-overlay
	// host can re-measure on a reorder that fires no geometry event.
	const [tree, setTree] = useState<LayoutTree>(() => model.get())
	const [epoch, setEpoch] = useState<number>(0)

	useEffect(() => {
		// Re-sync immediately in case the model changed between the initial
		// `useState` read and effect commit, then track future emissions.
		setTree(model.get())
		const unsubscribe = model.subscribe((snap) => {
			setTree(snap.tree)
			setEpoch(snap.revision)
		})
		return unsubscribe
	}, [model])

	const handleActivate = useCallback(
		(groupId: string, panelId: string) => {
			model.apply((t) => setActive(t, groupId, panelId))
		},
		[model],
	)

	// Close write-back: a tab's close affordance funnels here, applying
	// `closePanel` to the canonical model (which removes + collapses + re-derives
	// active, or NO-OPs on the final panel). Same single-`apply` discipline as
	// `handleActivate`/`handleRedock`.
	const handleClose = useCallback(
		(panelId: string) => {
			model.apply((t) => closePanel(t, panelId))
		},
		[model],
	)

	// Total panels across the WHOLE tree. The close affordance is suppressed only
	// when the entire layout has a single panel left (closing it would no-op);
	// a multi-panel single group still shows closes. GroupView sees only its own
	// node, so we compute the global count here and thread `canClose` down.
	const canClose = countPanels(tree.root) > 1

	// Panel-id membership of the CURRENT tree (M2). A drop's payload must be a
	// panel that actually lives in the tree, not merely one that is registered —
	// see `handleDrop`. Derived from the snapshot the component already holds.
	const isPanelInTree = useCallback(
		(panelId: string) => findPanelGroupId(tree.root, panelId) !== undefined,
		[tree],
	)

	// Resize write-back: a drag commit (or the `__deckApplyLayout` seam) funnels
	// new per-split weights here, which apply `setSizes` to the canonical model.
	const handleApplyLayout = useCallback(
		(splitId: string, weights: number[]) => {
			model.apply((t) => setSizes(t, splitId, weights))
		},
		[model],
	)

	// Drag-to-redock commit. A tab dragged onto `groupId`'s `zone` (the GROUP seam
	// or a real dragover) lands here. `activePanelId` is the group's natural split
	// anchor (the visible body the user dropped onto). We translate the zone to an
	// engine-neutral descriptor, skip true no-ops (drop onto own tab center), and
	// apply the descriptor:
	//   - move  => single `movePanel` (joins the target tab group).
	//   - split => extract-then-split COMPOSED in ONE `model.apply` so the whole
	//     re-dock is a single atomic emission (one subscriber notification, one
	//     re-render): `splitPanel` throws if the dragged panel already exists, so
	//     an EXISTING panel must be `extractPanel`'d first, then split against the
	//     target. Doing both inside one `apply` keeps the tree from ever being
	//     observed in the transient extracted state.
	const handleRedock = useCallback(
		(
			groupId: string,
			activePanelId: string,
			draggedPanelId: string,
			zone: DropZone,
			reorderIndex?: number,
		) => {
			const target = { groupId, panelId: activePanelId }
			// The dragged panel's CURRENT group — needed to skip a center-drop back
			// into its own group (M2) and (via `dragged === target.panelId`) a
			// self-split (M1).
			const draggedGroupId = findPanelGroupId(model.get().root, draggedPanelId)

			// ── PanelCapabilities gate (GOAL A target): a group whose ACTIVE panel is
			// `draggable:false` is a locked drop ANCHOR — nothing may join or split
			// against it, in any zone. Checked before the no-op/reorder logic so a
			// locked simulator/editor can never absorb another panel. ──
			if (registry.get(activePanelId)?.draggable === false) return

			// ── PanelCapabilities gate (GOAL B): a `reorder-only` dragged panel may
			// ONLY reorder WITHIN its own group. It never leaves the group (a center
			// drop into another group) and never edge-splits (any edge zone, own or
			// other group). The one motion it permits — a center drop into its OWN
			// group — must OVERRIDE `isNoopRedock` (which would swallow it as churn).
			if (registry.get(draggedPanelId)?.dropPolicy === 'reorder-only') {
				if (draggedGroupId === undefined || draggedGroupId !== groupId) return
				if (zone !== 'center') return
				// Anchor the reorder on the pointer-derived index when the gesture
				// supplies one (real drag), else on the active anchor's CURRENT index
				// (the imperative seam carries no pointer).
				const group = findGroupById(model.get().root, groupId)
				const index = reorderIndex ?? (group ? group.panels.indexOf(activePanelId) : undefined)
				model.apply((t) => movePanel(t, draggedPanelId, { groupId, index }))
				return
			}

			if (isNoopRedock(draggedPanelId, draggedGroupId, target, zone)) return
			const mutation = dropZoneToMutation(zone, draggedPanelId, target)
			if (mutation.kind === 'move') {
				model.apply((t) => movePanel(t, mutation.panelId, { groupId: mutation.destGroupId }))
				return
			}
			// Atomic extract-then-split for an existing dragged panel. Defensive
			// guard (M1): if extracting the dragged panel removed the split anchor,
			// abort instead of letting `splitPanel` throw on a missing anchor.
			model.apply((t) => {
				const { tree } = extractPanel(t, mutation.newPanelId)
				if (findPanelGroupId(tree.root, mutation.atPanelId) === undefined) return t
				return splitPanel(tree, mutation.atPanelId, mutation.dir, mutation.newPanelId, mutation.side)
			})
		},
		[model, registry],
	)

	return (
		<LayoutEpochContext.Provider value={epoch}>
			{renderNode(tree.root, {
				registry,
				renderDomPanel,
				bindNativeSlot,
				onActivate: handleActivate,
				onApplyLayout: handleApplyLayout,
				onRedock: handleRedock,
				onClose: handleClose,
				canClose,
				isPanelInTree,
			})}
		</LayoutEpochContext.Provider>
	)
}

/** A split wrapper element augmented with the resize write-back seam plus the
 * rrp Group imperative handle (M1 model→view sync). Hosts/tests reach the live
 * split layout through `__deckGroupApi` the same way they reach the write-back
 * through `__deckApplyLayout`. */
type DeckSplitElement = HTMLDivElement & {
	__deckApplyLayout?: (weights: number[]) => void
	__deckGroupApi?: GroupImperativeHandle
}

/** A group wrapper element augmented with the drop-handling seam. Mirrors the
 * `__deckApplyLayout` discipline on split elements: an imperative hook the
 * gesture (or a unit test) calls to commit a re-dock against the model. */
type DeckGroupElement = HTMLDivElement & {
	__deckHandleDrop?: (draggedPanelId: string, zone: DropZone) => void
}

interface RenderContext {
	registry: PanelRegistry
	renderDomPanel: (panelId: string, opts: { active: boolean }) => ReactNode
	bindNativeSlot: (panelId: string, el: HTMLElement | null) => void
	onActivate: (groupId: string, panelId: string) => void
	onApplyLayout: (splitId: string, weights: number[]) => void
	onRedock: (
		groupId: string,
		activePanelId: string,
		draggedPanelId: string,
		zone: DropZone,
		/** Pointer-derived insertion index for a within-group reorder
		 * (`dropPolicy:'reorder-only'`). Omitted by the imperative seam, which
		 * falls back to the active anchor's current index. */
		reorderIndex?: number,
	) => void
	onClose: (panelId: string) => void
	/** False when the whole tree has a single panel — suppresses every close
	 * button so the layout can't be emptied (closePanel would no-op anyway). */
	canClose: boolean
	/** True iff `panelId` is present in the CURRENT layout tree (M2). Registry
	 * membership is NOT enough: a panel can be registered but absent from the tree
	 * (closed out / never docked), and driving a re-dock on it makes the mutation
	 * layer throw `panel not found`. A drop carrying such an id must be a no-op. */
	isPanelInTree: (panelId: string) => boolean
}

/** The id of the tab group currently holding `panelId`, or `undefined` if the
 * panel is not in the tree. Used by `handleRedock` to detect a drop back into
 * the dragged panel's own group (M2) and to guard a vanished split anchor (M1). */
function findPanelGroupId(node: LayoutNode, panelId: string): string | undefined {
	if (node.kind === 'tabs') {
		return node.panels.includes(panelId) ? node.id : undefined
	}
	for (const child of node.children) {
		const found = findPanelGroupId(child, panelId)
		if (found !== undefined) return found
	}
	return undefined
}

/** The tab-group node with `groupId`, or `undefined`. Used by `handleRedock` to
 * read the live `panels` order of a reorder target (to anchor a same-group
 * reorder on the active panel's current index when the gesture carries no
 * pointer-derived index — e.g. the `__deckHandleDrop` test seam). */
function findGroupById(node: LayoutNode, groupId: string): TabGroupNode | undefined {
	if (node.kind === 'tabs') return node.id === groupId ? node : undefined
	for (const child of node.children) {
		const found = findGroupById(child, groupId)
		if (found !== undefined) return found
	}
	return undefined
}

/** Total panels anywhere in the tree. Drives the last-panel close suppression:
 * a GroupView only knows its own node, so DockView computes this global count
 * once and threads the resulting `canClose` boolean down. */
function countPanels(node: LayoutNode): number {
	if (node.kind === 'tabs') return node.panels.length
	return node.children.reduce((sum, child) => sum + countPanels(child), 0)
}

function renderNode(node: LayoutNode, ctx: RenderContext): ReactNode {
	return node.kind === 'split'
		? renderSplit(node, ctx)
		: renderGroup(node, ctx)
}

/** A split is a stateful component (it holds the rrp Group imperative ref + runs
 * the M1 model→view sync effect), so render it via JSX with a STABLE key so
 * React preserves that ref / its kept-alive subtree across model emissions
 * rather than remounting on every snapshot. Mirrors `renderGroup`/`GroupView`. */
function renderSplit(node: SplitNode, ctx: RenderContext): ReactNode {
	return <SplitView key={node.id} node={node} ctx={ctx} />
}

interface SplitViewProps {
	node: SplitNode
	ctx: RenderContext
}

/** Epsilon (in percentage points) within which two split layouts are treated as
 * equivalent. Guards BOTH sides of the model↔view loop: we skip pushing a
 * `setLayout` when the live layout already matches the target, and skip the
 * `onLayoutChanged` write-back when the incoming layout matches the model — so
 * `setLayout`→`onLayoutChanged`→write-back→re-sync cannot loop. */
const LAYOUT_EPSILON = 0.5

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
const FLEX_RATIO_TOLERANCE = 0.1

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
function flexibleFloor(flexCount: number): number {
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
function clampFlexibleWeights(
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
 * Build the panel-ID→PERCENTAGE map for an imperative `setLayout`, given the
 * model's full-length raw `sizes` (per child) and `constraints`:
 *
 *  - FIXED (px-pinned) children keep their CURRENT measured percentage (read
 *    from the live `getLayout()`); they are NOT derived from weights, so a
 *    flexible-weights change never disturbs their pixel lock.
 *  - The REMAINING percentage (100 − Σ fixed%) is distributed across the
 *    FLEXIBLE children in proportion to their weights.
 *
 * Returns `null` when the map can't be built faithfully (e.g. `live` is empty —
 * jsdom's stub — or a fixed child's live % is missing), so the caller skips the
 * `setLayout` rather than pushing a corrupt total. The result always sums to
 * ~100 over all children.
 */
function buildSetLayoutMap(
	childIds: readonly string[],
	sizes: readonly number[],
	constraints: readonly (SizeConstraint | null)[] | undefined,
	live: Record<string, number>,
): Record<string, number> | null {
	const isFixedAt = (i: number): boolean => (constraints?.[i] ?? null) !== null

	// Sum the fixed children's CURRENT live percentages (preserve their px lock).
	let fixedTotal = 0
	for (let i = 0; i < childIds.length; i++) {
		if (!isFixedAt(i)) continue
		const livePct = live[childIds[i]!]
		// Without a measured live % for a fixed child we cannot preserve its px
		// lock faithfully — bail so we don't corrupt the fixed child.
		if (typeof livePct !== 'number') return null
		fixedTotal += livePct
	}

	const remaining = Math.max(0, 100 - fixedTotal)

	// Flexible weight pool.
	let flexWeightTotal = 0
	for (let i = 0; i < childIds.length; i++) {
		if (isFixedAt(i)) continue
		const w = sizes[i] ?? 0
		flexWeightTotal += w > 0 ? w : 0
	}
	const flexibleCount = childIds.length - childIds.filter((_, i) => isFixedAt(i)).length

	const out: Record<string, number> = {}
	for (let i = 0; i < childIds.length; i++) {
		const id = childIds[i]!
		if (isFixedAt(i)) {
			out[id] = live[id]!
			continue
		}
		if (flexWeightTotal <= 0) {
			// Degenerate flexible weights → split the remaining space evenly.
			out[id] = flexibleCount > 0 ? remaining / flexibleCount : remaining
			continue
		}
		const w = sizes[i] ?? 0
		out[id] = (remaining * (w > 0 ? w : 0)) / flexWeightTotal
	}
	return out
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
function incomingFlexRatios(
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

function SplitView(props: SplitViewProps): ReactNode {
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
	// ref so an external `setSizes` syncs against the latest model. Returns true if
	// a `setLayout` was actually pushed.
	const runSync = useCallback((): boolean => {
		const api = groupRef.current
		if (!api) return false
		const cur = nodeRef.current
		const curChildIds = cur.children.map((c) => c.id)

		const live = api.getLayout()
		// jsdom's stub returns `{}` (no measured geometry) — buildSetLayoutMap then
		// returns null for any fixed child, and for the all-flexible case the
		// equivalence check below sees missing live ids and proceeds; but `setLayout`
		// is a no-op under jsdom anyway. In a real renderer `live` is populated.
		const targetMap = buildSetLayoutMap(curChildIds, cur.sizes, cur.constraints, live)
		if (!targetMap) return false

		// SET-side redundant-push skip: don't re-push a layout the live Group already
		// satisfies. This is the loop break on the SET side — pushing an identical
		// layout would re-emit `onLayoutChanged`, but its flexible ratios match the
		// model so the normalized compare in `handleLayoutChanged` skips the write-back
		// anyway; this skip just avoids the redundant work.
		if (layoutsEquivalent(live, targetMap, curChildIds)) return false

		api.setLayout(targetMap)
		return true
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
	useEffect(() => {
		runSync()
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

function renderGroup(node: TabGroupNode, ctx: RenderContext): ReactNode {
	// A group is a stateful component (it tracks the live drop-hover zone during a
	// drag), so render it via JSX with a STABLE key so React preserves that hover
	// state across model emissions rather than remounting on every snapshot.
	return <GroupView key={node.id} node={node} ctx={ctx} />
}

interface GroupViewProps {
	node: TabGroupNode
	ctx: RenderContext
}

/**
 * One tab GROUP: tab strip (draggable tabs) + active body + the imperative
 * `__deckHandleDrop` seam + a geometry-driven drop indicator while a drag hovers.
 */
function GroupView(props: GroupViewProps): ReactNode {
	const { node, ctx } = props

	// The live drop zone under the pointer during a drag-over (null = no drag over
	// this group). Drives the `data-deck-drop-zone` indicator. jsdom can't produce
	// real geometry (getBoundingClientRect is 0), so this path is exercised by the
	// real-pointer e2e `it.todo`s; here we implement it for real-browser fidelity.
	const [dropZone, setDropZone] = useState<DropZone | null>(null)

	// Keep the latest node + redock callback reachable from the imperative ref
	// seam without re-running the ref effect when they change identity. The seam
	// always anchors a split at the group's CURRENT active panel.
	const nodeRef = useRef(node)
	nodeRef.current = node
	const redockRef = useRef(ctx.onRedock)
	redockRef.current = ctx.onRedock

	// Ref-callback exposing the drop seam on the group element. Mirrors
	// `setSplitRef`/`__deckApplyLayout`: the gesture and the unit seam both land on
	// the same `onRedock` engine path. The seam owns choosing the target panel —
	// the group's active panel is the natural anchor for an edge split.
	const setGroupRef = (el: DeckGroupElement | null): void => {
		if (el) {
			el.__deckHandleDrop = (draggedPanelId: string, zone: DropZone) => {
				const current = nodeRef.current
				redockRef.current(current.id, current.active, draggedPanelId, zone)
			}
		}
	}

	// ── drag-over geometry ────────────────────────────────────────────────
	// Compute the hovered zone from the pointer position relative to the group
	// rect. `preventDefault` is required for the element to be a valid drop target.
	const handleDragOver = (e: DragEvent<HTMLDivElement>): void => {
		e.preventDefault()
		const rect = e.currentTarget.getBoundingClientRect()
		const zone = computeDropZone(
			{ width: rect.width, height: rect.height },
			{ x: e.clientX - rect.left, y: e.clientY - rect.top },
		)
		setDropZone(zone)
	}

	const handleDragLeave = (): void => {
		setDropZone(null)
	}

	// On drop, recover the dragged panel id (custom MIME first, falling back to
	// the source tab marker carried as text), then commit via the same seam path.
	const handleDrop = (e: DragEvent<HTMLDivElement>): void => {
		e.preventDefault()
		const rect = e.currentTarget.getBoundingClientRect()
		const zone = computeDropZone(
			{ width: rect.width, height: rect.height },
			{ x: e.clientX - rect.left, y: e.clientY - rect.top },
		)
		setDropZone(null)
		const dragged
			= e.dataTransfer.getData(DRAG_PANEL_MIME) || e.dataTransfer.getData('text/plain')
		// Validate the payload before committing a re-dock:
		//  - M4: a `text/plain` drop can carry arbitrary external text (a selection,
		//    a file path); it must at least be a REGISTERED panel.
		//  - M2: registry membership is NOT tree membership. A registered-but-absent
		//    panel (closed out of the tree / never docked) passes the registry guard
		//    yet drives `movePanel`/`extractPanel` on an id missing from the tree,
		//    which THROWS `panel not found`. It must be a NO-OP — also require the id
		//    to be present in the CURRENT tree.
		if (!dragged || ctx.registry.get(dragged) === undefined || !ctx.isPanelInTree(dragged)) return
		// Pointer-derived insertion index for a within-group REORDER
		// (`dropPolicy:'reorder-only'`): measure this group's tab rects and map the
		// pointer x onto an index. Ignored by `handleRedock` for every non-reorder
		// path, so it is safe to compute unconditionally.
		const tabRects = Array.from(
			e.currentTarget.querySelectorAll<HTMLElement>('[data-deck-tab]'),
		).map((el) => {
			const r = el.getBoundingClientRect()
			return { left: r.left, width: r.width }
		})
		const reorderIndex = computeReorderIndex(tabRects, e.clientX)
		ctx.onRedock(node.id, node.active, dragged, zone, reorderIndex)
	}

	// The tab STRIP is a first-class REORDER drop target. It sits at the TOP of
	// the group, so a tab dropped onto it would otherwise resolve to the group's
	// `top` EDGE zone via `computeDropZone` — which a `reorder-only` panel rejects
	// as a no-op, so reordering by dragging within the tab bar would never work.
	// Intercept strip drops here and commit a `center` re-dock carrying the
	// pointer-x insertion index (`handleRedock` reorders within the group).
	// `stopPropagation` keeps the group's edge/center drop handlers from also
	// firing for the same gesture.
	const handleTabStripDragOver = (e: DragEvent<HTMLDivElement>): void => {
		if (!e.dataTransfer.types.includes(DRAG_PANEL_MIME)) return
		e.preventDefault()
		e.stopPropagation()
		setDropZone(null)
	}
	const handleTabStripDrop = (e: DragEvent<HTMLDivElement>): void => {
		e.preventDefault()
		e.stopPropagation()
		setDropZone(null)
		const dragged
			= e.dataTransfer.getData(DRAG_PANEL_MIME) || e.dataTransfer.getData('text/plain')
		if (!dragged || ctx.registry.get(dragged) === undefined || !ctx.isPanelInTree(dragged)) return
		const tabRects = Array.from(
			e.currentTarget.querySelectorAll<HTMLElement>('[data-deck-tab]'),
		).map((el) => {
			const r = el.getBoundingClientRect()
			return { left: r.left, width: r.width }
		})
		const reorderIndex = computeReorderIndex(tabRects, e.clientX)
		ctx.onRedock(node.id, node.active, dragged, 'center', reorderIndex)
	}

	// Panels that contribute a tab to the strip (`hideTab` panels carry their own
	// chrome — e.g. the simulator's device picker — so the engine tab is omitted).
	// When NONE remain the tab strip is not rendered at all and the body fills the
	// whole group region.
	const visibleTabs = node.panels.filter((panelId) => !ctx.registry.get(panelId)?.hideTab)

	// FILL LAYOUT (FIX 2a): the group must be a flex COLUMN that fills its
	// allotted panel region so a leaf native slot can stretch to the full area.
	// Without this the group div is content-height (the tab strip only), the
	// active body / NativeSlot measures 0 height, the view-anchor publishes a
	// collapsed rect, and the simulator WebContentsView is invisible. The tab
	// strip is `shrink: 0`; the active body takes the remaining space (flex: 1).
	return (
		<div
			ref={setGroupRef}
			data-deck-group={node.id}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
			style={{
				position: 'relative',
				display: 'flex',
				flexDirection: 'column',
				width: '100%',
				height: '100%',
				minWidth: 0,
				minHeight: 0,
			}}
		>
			{visibleTabs.length > 0 ? (
				<div
				role="tablist"
				style={{ flexShrink: 0 }}
				onDragOver={handleTabStripDragOver}
				onDrop={handleTabStripDrop}
			>
				{visibleTabs.map((panelId) => {
					const active = panelId === node.active
					const descriptor = ctx.registry.get(panelId)
					const title = descriptor?.title ?? panelId
					// PanelCapabilities (GOAL A source): a `draggable:false` panel's tab
					// cannot be picked up — omit the marker entirely (an absent attribute,
					// not `draggable="false"`, matches the "no drag source" contract).
					const isDraggable = descriptor?.draggable !== false
					return (
						<button
							key={panelId}
							type="button"
							role="tab"
							draggable={isDraggable ? 'true' : undefined}
							data-deck-tab={panelId}
							data-active={active ? 'true' : 'false'}
							onDragStart={(e) => {
								// A press that BEGINS on the close affordance must not drag the
								// whole tab: the HTML5 drag source is the draggable ANCESTOR
								// (this tab) regardless of which descendant the pointer landed
								// on, so a descendant's stopPropagation cannot cancel it —
								// detect the origin here and abort the drag. `closest` walks up
								// from the event target; a hit means the gesture started on ×.
								if (
									e.target instanceof Element
									&& e.target.closest('[data-deck-tab-close]') !== null
								) {
									e.preventDefault()
									return
								}
								// Record the dragged panel id so the drop target can recover it.
								e.dataTransfer.setData(DRAG_PANEL_MIME, panelId)
								e.dataTransfer.setData('text/plain', panelId)
								e.dataTransfer.effectAllowed = 'move'
							}}
							onClick={() => {
								if (!active) ctx.onActivate(node.id, panelId)
							}}
						>
							{title}
							{/* Close affordance — a `role="button"` SPAN (NOT a nested <button>:
							   an interactive button may not be a descendant of another button —
							   invalid HTML + illegal a11y nesting). `tabIndex={0}` + the
							   Enter/Space keydown keep it keyboard/AT-operable. Suppressed when
							   the WHOLE tree has one panel left (`canClose` false). Activate is
							   kept off the tab (click stopPropagation) and a tab drag that
							   begins here is cancelled by the tab's onDragStart guard above. */}
							{ctx.canClose
								? (
									<span
										role="button"
										tabIndex={0}
										data-deck-tab-close={panelId}
										aria-label={`Close ${title}`}
										onPointerDown={(e) => e.stopPropagation()}
										onClick={(e) => {
											e.stopPropagation()
											e.preventDefault()
											ctx.onClose(panelId)
										}}
										onKeyDown={(e) => {
											if (e.key === 'Enter' || e.key === ' ') {
												e.stopPropagation()
												e.preventDefault()
												ctx.onClose(panelId)
											}
										}}
									>
										×
									</span>
									)
								: null}
						</button>
					)
				})}
			</div>
			) : null}
			{renderActiveBody(node, ctx)}
			{dropZone ? <DropIndicator zone={dropZone} /> : null}
		</div>
	)
}

/**
 * Translate a drop zone into the indicator overlay's geometry. `center` covers
 * the whole group (a tab-join highlight); each edge zone is a HALF-band ribbon
 * pinned to that edge. Pure presentation — the host can re-skin via the
 * `data-deck-drop-zone` attribute; these inline styles are a sane default.
 */
function dropIndicatorStyle(zone: DropZone): Record<string, string> {
	const base: Record<string, string> = {
		position: 'absolute',
		// `none` so the overlay never steals the drag-over/drop events from the
		// group beneath it (otherwise the indicator itself would become the target).
		pointerEvents: 'none',
		background: 'rgba(64, 128, 255, 0.25)',
		outline: '2px solid rgba(64, 128, 255, 0.6)',
	}
	switch (zone) {
		case 'left':
			return { ...base, left: '0', top: '0', width: '50%', height: '100%' }
		case 'right':
			return { ...base, right: '0', top: '0', width: '50%', height: '100%' }
		case 'top':
			return { ...base, left: '0', top: '0', width: '100%', height: '50%' }
		case 'bottom':
			return { ...base, left: '0', bottom: '0', width: '100%', height: '50%' }
		case 'center':
		default:
			return { ...base, left: '0', top: '0', width: '100%', height: '100%' }
	}
}

/** The drop-zone highlight rendered over a group during a drag-over. */
function DropIndicator(props: { zone: DropZone }): ReactNode {
	return <div data-deck-drop-zone={props.zone} style={dropIndicatorStyle(props.zone)} />
}

/**
 * Render a tab group's body region under DOM-panel KEEPALIVE.
 *
 * - DOM panels: ALL of the group's DOM panels are mounted SIMULTANEOUSLY, each
 *   under a STABLE React key (`dom-${panelId}`) so switching the active tab never
 *   remounts a body — React state + scroll persist across A→B→A. The active body
 *   fills the region (flex:1); inactive ones stay in the DOM but `display:none`.
 *   Each body's host renderer receives `{ active }` and is re-invoked with the
 *   new flag on every activation change (no remount), so a host can fire
 *   on-activation side effects off the false→true edge.
 * - Native panels: EXEMPT from keepalive. The single ACTIVE native panel mounts a
 *   `NativeSlot` (keyed on the active id, so deactivation unmounts it and fires
 *   `bindNativeSlot(id, null)`); inactive native panels render nothing. Keeping a
 *   bound native slot mounted-but-hidden would collapse its WebContentsView rect.
 */
function renderActiveBody(node: TabGroupNode, ctx: RenderContext): ReactNode {
	const activeId = node.active
	if (!activeId) return null

	const activeDescriptor = ctx.registry.get(activeId)

	// Native active panel → active-only NativeSlot (no keepalive).
	const nativeSlot
		= activeDescriptor?.kind === 'native'
			? (
				<NativeSlot
					key={activeId}
					panelId={activeId}
					bindNativeSlot={ctx.bindNativeSlot}
				/>
				)
			: null

	// Every DOM (non-native) panel in the group is kept alive: mounted up-front,
	// hidden unless active. A panel with no descriptor is treated as DOM (render
	// via the host's renderer) — matching the pre-keepalive fallback.
	const domBodies = node.panels
		.filter((panelId) => ctx.registry.get(panelId)?.kind !== 'native')
		.map((panelId) => {
			const active = panelId === activeId
			return (
				<div
					key={`dom-${panelId}`}
					data-deck-panel-body={panelId}
					style={{
						// Active body fills the region; inactive bodies stay mounted but
						// hidden (display:none preserves React state + scroll position).
						// A flex COLUMN container (not a bare block) so a host panel root
						// that fills via `flex:1`/`height:100%` actually stretches to the
						// full body height — without this such a root collapses to content
						// height and leaves dead space below it.
						display: active ? 'flex' : 'none',
						flexDirection: 'column',
						flex: 1,
						minWidth: 0,
						minHeight: 0,
					}}
				>
					{ctx.renderDomPanel(panelId, { active })}
				</div>
			)
		})

	return (
		<Fragment>
			{nativeSlot}
			{domBodies}
		</Fragment>
	)
}

interface NativeSlotProps {
	panelId: string
	bindNativeSlot: (panelId: string, el: HTMLElement | null) => void
}

/**
 * Empty anchor slot for an ACTIVE native panel. A ref-callback binds the live
 * element on mount and unbinds (`null`) on unmount. Keying the element on the
 * active panel id (in the parent) guarantees deactivation unmounts this slot —
 * firing the `null` cleanup — and re-activation mounts a fresh one, re-binding.
 */
function NativeSlot(props: NativeSlotProps): ReactNode {
	const { panelId, bindNativeSlot } = props
	// Keep the latest callback without re-running the ref effect on identity
	// churn of an inline `bindNativeSlot`.
	const bindRef = useRef(bindNativeSlot)
	bindRef.current = bindNativeSlot

	const setRef = useCallback(
		(el: HTMLDivElement | null) => {
			bindRef.current(panelId, el)
		},
		[panelId],
	)

	// FILL LAYOUT (FIX 2a): the empty anchor slot must fill the remaining group
	// region so the host's view-anchor measures the FULL panel rect, not a 0×0
	// box. `flex:1` claims the space below the tab strip; `min-*:0` lets it
	// shrink inside the flex column; `height:100%` is the belt-and-braces
	// fallback for any non-flex ancestor.
	return (
		<div
			ref={setRef}
			data-deck-native-slot={panelId}
			style={{ flex: 1, minWidth: 0, minHeight: 0, height: '100%' }}
		/>
	)
}
