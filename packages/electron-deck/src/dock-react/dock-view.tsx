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
 * react here does not violate the pure-TS layout boundary. The stateful child
 * views (`SplitView`, `GroupView`) and the body renderer live in sibling
 * modules; this file owns the orchestration (`renderNode`) + the shared
 * `RenderContext`.
 */
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from 'react'
import {
	closePanelForUser,
	countPanels,
	extractPanel,
	findGroupById,
	findPanelGroupId,
	movePanel,
	setActive,
	setSizes,
	splitPanel,
} from '../layout/index.js'
import type {
	LayoutModel,
	LayoutNode,
	LayoutTree,
	PanelRegistry,
	SplitNode,
	TabGroupNode,
} from '../layout/index.js'
import {
	dropZoneToMutation,
	isNoopRedock,
	resolveReorderInsertIndex,
	type DropZone,
} from './drag-redock.js'
import { SplitView } from './split-view.js'
import { GroupView } from './group-view.js'

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
	/**
	 * Opt-in: while a `dropPolicy:'reorder-only'` panel is dragged, paint NO drop
	 * indicator over a group body (its own edges or any other group) — those are
	 * no-op targets, so the highlight is misleading. Default `false` keeps the
	 * geometry-only indicator (it paints where the pointer is; the capability
	 * gate still rejects the drop). Hosts that want the cleaner "no misleading
	 * highlight" UX pass `true`.
	 */
	suppressReorderOnlyDropIndicator?: boolean
	/**
	 * Fires when the user clicks a tab that is ALREADY active. The host can use
	 * this to toggle the panel's visibility (e.g. collapse the debug group).
	 * When absent, clicking an active tab is a no-op (the existing behaviour).
	 */
	onActiveTabClick?: (panelId: string) => void
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

export function DockView(props: DockViewProps): ReactNode {
	const { model, registry, renderDomPanel, bindNativeSlot, suppressReorderOnlyDropIndicator, onActiveTabClick } = props

	// Snapshot the canonical tree; re-render on every external emission. The
	// `epoch` mirrors the model revision (0 before the first apply) and is
	// provided to descendant panels via `LayoutEpochContext` so a native-overlay
	// host can re-measure on a reorder that fires no geometry event.
	const [tree, setTree] = useState<LayoutTree>(() => model.get())
	const [epoch, setEpoch] = useState<number>(0)

	// The panel id of the in-flight tab drag, INSTANCE-scoped (per DockView). Set
	// on `dragstart`, cleared on `dragend`/`drop`. The DataTransfer VALUE is
	// unreadable during `dragover` (only `types` is exposed, by spec), so the
	// drop-indicator path can't recover the dragged id from the event — it reads
	// it from here instead to decide whether to paint a highlight for THIS drag
	// (e.g. a `reorder-only` panel shows none). Held per instance (not module
	// scope) so two DockViews on one page never share a drag and unmount leaves no
	// residue. Threaded to every GroupView via the RenderContext.
	const activeDragPanelId = useRef<string | null>(null)

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

	// Close write-back: every tab close funnels through the capability-aware
	// user action. The generic `closePanel` mutation remains available to
	// programmatic layout transforms.
	const handleClose = useCallback(
		(panelId: string) => {
			model.apply((t) => closePanelForUser(t, panelId, registry))
		},
		[model, registry],
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

			// ── PanelCapabilities gate (GOAL A source): a `draggable:false` panel is
			// a locked STRUCTURAL panel — it can never be torn into another region.
			// UI drag-start already refuses to lift it, but the imperative drop seam
			// bypasses that, so reject a locked dragged source here too (defense in
			// depth) — its position in the tree is fixed. ──
			if (registry.get(draggedPanelId)?.draggable === false) return

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
				// (the imperative seam carries no pointer). The pointer index is a
				// VISIBLE-tab strip index (hideTab panels omitted, dragged tab's own
				// slot counted); translate it into the `movePanel` insertion index —
				// the strip↔model coordinate reconciliation lives only here.
				const group = findGroupById(model.get().root, groupId)
				let index: number | undefined
				if (reorderIndex !== undefined && group) {
					const visibleTabIds = group.panels.filter(
						(panelId) => registry.get(panelId)?.hideTab !== true,
					)
					index = resolveReorderInsertIndex(group.panels, visibleTabIds, draggedPanelId, reorderIndex)
				}
				else {
					index = group ? group.panels.indexOf(activePanelId) : undefined
				}
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
				onActiveTabClick,
				onApplyLayout: handleApplyLayout,
				onRedock: handleRedock,
				onClose: handleClose,
				canClose,
				isPanelInTree,
				suppressReorderOnlyDropIndicator: suppressReorderOnlyDropIndicator ?? false,
				activeDragPanelId,
			})}
		</LayoutEpochContext.Provider>
	)
}

/** The shared per-render context threaded from `DockView` down through
 * `renderNode` into every `SplitView`/`GroupView`. Exported so the sibling view
 * modules type their `ctx` against the single source. */
export interface RenderContext {
	registry: PanelRegistry
	renderDomPanel: (panelId: string, opts: { active: boolean }) => ReactNode
	bindNativeSlot: (panelId: string, el: HTMLElement | null) => void
	onActivate: (groupId: string, panelId: string) => void
	onActiveTabClick: ((panelId: string) => void) | undefined
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
	/** See {@link DockViewProps.suppressReorderOnlyDropIndicator}. */
	suppressReorderOnlyDropIndicator: boolean
	/** The in-flight tab-drag panel id, INSTANCE-scoped to the owning DockView
	 * (set on `dragstart`, cleared on `dragend`/`drop`). The drop-indicator path
	 * reads it during `dragover`, where the DataTransfer value is unreadable. */
	activeDragPanelId: { current: string | null }
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

function renderGroup(node: TabGroupNode, ctx: RenderContext): ReactNode {
	// A group is a stateful component (it tracks the live drop-hover zone during a
	// drag), so render it via JSX with a STABLE key so React preserves that hover
	// state across model emissions rather than remounting on every snapshot.
	return <GroupView key={node.id} node={node} ctx={ctx} />
}

export { renderNode }
