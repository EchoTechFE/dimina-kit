/**
 * `GroupView` — one tab GROUP: the draggable tab strip, the active body, the
 * imperative `__deckHandleDrop` seam, and a geometry-driven drop indicator while
 * a drag hovers. Owns all tab drag/drop handlers.
 */
import { useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { TabGroupNode } from '../layout/index.js'
import { computeDropZone, computeReorderIndex, type DropZone } from './drag-redock.js'
import { renderActiveBody } from './panel-body.js'
import type { RenderContext } from './dock-view.js'

/**
 * The dataTransfer MIME under which a drag carries the dragged panel id. A
 * custom type (vs `text/plain`) keeps deck drags from being confused with
 * arbitrary text drops; the panel id also stays recoverable from the source
 * tab's `data-deck-tab` attribute (the jsdom seam relies on the latter).
 */
const DRAG_PANEL_MIME = 'application/x-deck-panel'

/** A group wrapper element augmented with the drop-handling seam. Mirrors the
 * `__deckApplyLayout` discipline on split elements: an imperative hook the
 * gesture (or a unit test) calls to commit a re-dock against the model. */
type DeckGroupElement = HTMLDivElement & {
	__deckHandleDrop?: (draggedPanelId: string, zone: DropZone) => void
}

export interface GroupViewProps {
	node: TabGroupNode
	ctx: RenderContext
}

/**
 * One tab GROUP: tab strip (draggable tabs) + active body + the imperative
 * `__deckHandleDrop` seam + a geometry-driven drop indicator while a drag hovers.
 */
export function GroupView(props: GroupViewProps): ReactNode {
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
		// Only a genuine deck drag (carrying the deck panel MIME) may drive the drop
		// geometry — same contract the tab strip enforces. A foreign OS drag (files,
		// external text) never previews a drop indicator nor becomes a valid target.
		if (!e.dataTransfer?.types.includes(DRAG_PANEL_MIME)) return
		e.preventDefault()
		// Opt-in (suppressReorderOnlyDropIndicator): a `reorder-only` panel can ONLY
		// land via a within-group tab-strip reorder (handled by the strip handlers,
		// which paint no indicator). Anywhere the group body would resolve to — its
		// own edges or ANY other group — is a no-op for it, so the blue drop
		// highlight there is misleading. When opted in, suppress it entirely while
		// such a panel is in flight. Default keeps the geometry-only indicator (the
		// capability gate still rejects the drop at drop time).
		const draggedId = ctx.activeDragPanelId.current
		if (
			ctx.suppressReorderOnlyDropIndicator
			&& draggedId !== null
			&& ctx.registry.get(draggedId)?.dropPolicy === 'reorder-only'
		) {
			setDropZone(null)
			return
		}
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
		// Only the deck's own MIME identifies a panel drag. A `text/plain` value from
		// a foreign drag may coincide with a registered panel id, so it is NOT trusted.
		const dragged = e.dataTransfer?.getData(DRAG_PANEL_MIME)
		// Validate the payload before committing a re-dock:
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
		if (!e.dataTransfer?.types.includes(DRAG_PANEL_MIME)) return
		e.preventDefault()
		e.stopPropagation()
		setDropZone(null)
	}
	const handleTabStripDrop = (e: DragEvent<HTMLDivElement>): void => {
		e.preventDefault()
		e.stopPropagation()
		setDropZone(null)
		// Only the deck's own MIME identifies a panel drag (a foreign `text/plain`
		// value may coincide with a registered id and must not drive a reorder).
		const dragged = e.dataTransfer?.getData(DRAG_PANEL_MIME)
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
								// Also expose it to the dragover indicator path (DataTransfer
								// values are unreadable during dragover).
								ctx.activeDragPanelId.current = panelId
							}}
							onDragEnd={() => {
								ctx.activeDragPanelId.current = null
							}}
							onClick={() => {
								if (!active) ctx.onActivate(node.id, panelId)
								else ctx.onActiveTabClick?.(panelId)
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
							{ctx.canClose && descriptor?.closable !== false
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
