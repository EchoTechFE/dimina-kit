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
	Fragment,
	useCallback,
	useEffect,
	useRef,
	useState,
	type DragEvent,
	type ReactNode,
} from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import type { Layout } from 'react-resizable-panels'
import { closePanel, extractPanel, movePanel, setActive, setSizes, splitPanel } from '../layout/index.js'
import type {
	LayoutModel,
	LayoutNode,
	LayoutTree,
	PanelRegistry,
	SplitNode,
	TabGroupNode,
} from '../layout/index.js'
import {
	computeDropZone,
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
	renderDomPanel: (panelId: string) => ReactNode
	bindNativeSlot: (panelId: string, el: HTMLElement | null) => void
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
 * Compute the `defaultSize` percentage for each FLEXIBLE (unconstrained) child,
 * keyed by its ORIGINAL child index. Fixed (px-pinned) children are excluded
 * from the pool entirely so their weight never pollutes the flexible siblings'
 * normalization (FIX E1). `constraints[i]` non-null ⇒ child i is fixed and is
 * absent from the returned map.
 */
export function computeFlexiblePercentages(
	sizes: readonly number[],
	constraints: readonly ({ fixedPx: number } | null)[] | undefined,
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

	// Snapshot the canonical tree; re-render on every external emission.
	const [tree, setTree] = useState<LayoutTree>(() => model.get())

	useEffect(() => {
		// Re-sync immediately in case the model changed between the initial
		// `useState` read and effect commit, then track future emissions.
		setTree(model.get())
		const unsubscribe = model.subscribe((snap) => {
			setTree(snap.tree)
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
		(groupId: string, activePanelId: string, draggedPanelId: string, zone: DropZone) => {
			const target = { groupId, panelId: activePanelId }
			// The dragged panel's CURRENT group — needed to skip a center-drop back
			// into its own group (M2) and (via `dragged === target.panelId`) a
			// self-split (M1).
			const draggedGroupId = findPanelGroupId(model.get().root, draggedPanelId)
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
		[model],
	)

	return (
		<Fragment>
			{renderNode(tree.root, {
				registry,
				renderDomPanel,
				bindNativeSlot,
				onActivate: handleActivate,
				onApplyLayout: handleApplyLayout,
				onRedock: handleRedock,
				onClose: handleClose,
				canClose,
			})}
		</Fragment>
	)
}

/** A split wrapper element augmented with the resize write-back seam. */
type DeckSplitElement = HTMLDivElement & {
	__deckApplyLayout?: (weights: number[]) => void
}

/** A group wrapper element augmented with the drop-handling seam. Mirrors the
 * `__deckApplyLayout` discipline on split elements: an imperative hook the
 * gesture (or a unit test) calls to commit a re-dock against the model. */
type DeckGroupElement = HTMLDivElement & {
	__deckHandleDrop?: (draggedPanelId: string, zone: DropZone) => void
}

interface RenderContext {
	registry: PanelRegistry
	renderDomPanel: (panelId: string) => ReactNode
	bindNativeSlot: (panelId: string, el: HTMLElement | null) => void
	onActivate: (groupId: string, panelId: string) => void
	onApplyLayout: (splitId: string, weights: number[]) => void
	onRedock: (groupId: string, activePanelId: string, draggedPanelId: string, zone: DropZone) => void
	onClose: (panelId: string) => void
	/** False when the whole tree has a single panel — suppresses every close
	 * button so the layout can't be emptied (closePanel would no-op anyway). */
	canClose: boolean
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

function renderSplit(node: SplitNode, ctx: RenderContext): ReactNode {
	const orientation = node.orientation === 'row' ? 'horizontal' : 'vertical'

	// A child is FIXED (px-pinned) iff it carries a non-null constraint. Fixed
	// children are excluded from the flexible-percentage pool: their px panel does
	// not participate in weight-based sizing, so polluting `toPercentages` with
	// their weight would skew the flexible siblings' defaultSize. We therefore
	// normalize percentages over the FLEXIBLE indices only and map them back by
	// index; fixed children keep their px defaultSize/min/max.
	const isFixed = (i: number): boolean => (node.constraints?.[i] ?? null) !== null
	const percentageByIndex = computeFlexiblePercentages(node.sizes, node.constraints)

	// Ordered Panel ids — also the keys rrp's `onLayoutChanged` map is keyed by,
	// so we can convert that map back to ordered weights for the model write-back.
	const childIds = node.children.map((child) => child.id)

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
		// A non-null constraint pins the child to an exact pixel size: min===max
		// locks it in rrp (numeric/`"Npx"` strings are pixels in rrp v4.10), and
		// `groupResizeBehavior="preserve-pixel-size"` keeps it fixed while flexible
		// siblings absorb group resizes. Unconstrained siblings stay weight-sized.
		const constraint = node.constraints?.[i] ?? null
		if (constraint) {
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
		else {
			items.push(
				<Panel key={panelKey(child)} id={child.id} defaultSize={percentageByIndex.get(i)}>
					{renderNode(child, ctx)}
				</Panel>,
			)
		}
	})

	// A real rrp drag commits new per-Panel percentages here; map them back to
	// ordered weights (in child order) and funnel through the same write-back
	// seam the `__deckApplyLayout` host hook uses.
	const handleLayoutChanged = (layout: Layout): void => {
		// Build a FULL-LENGTH weights array (setSizes requires length ===
		// children.length). For FIXED children, preserve the model's existing weight
		// (node.sizes[i]) — rrp reports a container-derived percentage for the pinned
		// panel which, if written back, would irreversibly corrupt the stored weight
		// and lose it when the constraint is later cleared. Only FLEXIBLE children
		// take their rrp-reported value.
		const weights: number[] = []
		for (let i = 0; i < childIds.length; i++) {
			if (isFixed(i)) {
				weights.push(node.sizes[i] ?? 1)
				continue
			}
			const w = layout[childIds[i]!]
			if (typeof w !== 'number') return
			weights.push(w)
		}
		ctx.onApplyLayout(node.id, weights)
	}

	// Ref callback exposing the resize write-back seam on the split element. A
	// drag round-trip (e2e) and the unit seam both land on the same engine path.
	const setSplitRef = (el: DeckSplitElement | null): void => {
		if (el) {
			el.__deckApplyLayout = (weights: number[]) => {
				// Mirror handleLayoutChanged: a fixed child's stored weight is never
				// overwritten by an incoming (container-derived) value — preserve
				// node.sizes[i] for fixed indices so clearing the constraint later
				// restores the original weight. Flexible indices take the supplied value.
				const next = weights.map((w, i) => (isFixed(i) ? node.sizes[i] ?? 1 : w))
				ctx.onApplyLayout(node.id, next)
			}
		}
	}

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
		// Validate the payload is a REGISTERED panel (M4): a `text/plain` drop can
		// carry arbitrary external text (a selection, a file path); feeding that to
		// the mutation layer drives `extractPanel`/`movePanel` on a non-existent id
		// and throws. An unknown id is not a re-dock — ignore it.
		if (!dragged || ctx.registry.get(dragged) === undefined) return
		ctx.onRedock(node.id, node.active, dragged, zone)
	}

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
			<div role="tablist" style={{ flexShrink: 0 }}>
				{node.panels.map((panelId) => {
					const active = panelId === node.active
					const title = ctx.registry.get(panelId)?.title ?? panelId
					return (
						<button
							key={panelId}
							type="button"
							role="tab"
							draggable="true"
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

function renderActiveBody(node: TabGroupNode, ctx: RenderContext): ReactNode {
	const activeId = node.active
	if (!activeId) return null
	const descriptor = ctx.registry.get(activeId)

	if (descriptor?.kind === 'native') {
		return (
			<NativeSlot
				key={activeId}
				panelId={activeId}
				bindNativeSlot={ctx.bindNativeSlot}
			/>
		)
	}

	// DOM panel (or unknown descriptor — render via the host's DOM renderer).
	// Fill the remaining group space (FIX 2a): flex:1 + min-size:0 so the body
	// occupies the area below the tab strip rather than collapsing to content.
	return (
		<div
			data-deck-panel-body={activeId}
			style={{ flex: 1, minWidth: 0, minHeight: 0 }}
		>
			{ctx.renderDomPanel(activeId)}
		</div>
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
