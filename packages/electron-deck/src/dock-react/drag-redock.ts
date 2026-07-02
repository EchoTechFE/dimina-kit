/**
 * `drag-redock` — PURE geometry + descriptor layer for tab drag-to-redock.
 *
 * This module is intentionally REACT-FREE and ELECTRON-FREE so it can run under
 * the node `vitest.config.ts` suite (its spec is `drag-redock.test.ts`). It owns
 * two responsibilities, both pure functions of their inputs:
 *
 *   1. GEOMETRY — `computeDropZone(rect, point)` maps a pointer position over a
 *      group's rectangle to one of five drop zones (the four edge bands plus the
 *      interior `center`). This is the only place edge-band math lives; the React
 *      layer feeds it real `getBoundingClientRect` numbers during dragover.
 *
 *   2. DESCRIPTOR — `dropZoneToMutation(zone, dragged, target)` translates a zone
 *      into an engine-NEUTRAL `RedockMutation` intent (`move` | `split`). The
 *      descriptor only NAMES the intent; the React layer realizes it against the
 *      real tree (a split of an EXISTING panel needs extract-then-split, because
 *      `splitPanel` throws if the new panel already exists — see the caller).
 *
 * Keeping this split (geometry/descriptor here, engine application in React)
 * means the geometry is exhaustively unit-testable without a DOM, and the React
 * layer stays a thin gesture binding.
 */

/** The five drop zones: four edge bands + the tab-joining interior. */
export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

/**
 * Engine-neutral re-dock INTENT. `move` joins the dragged panel into a tab
 * group; `split` puts it adjacent to a target panel in a new split. This is a
 * pure descriptor — it does NOT itself touch a tree (the caller applies it,
 * extract-then-split'ing for an existing panel).
 */
export type RedockMutation =
	| { kind: 'move'; panelId: string; destGroupId: string }
	| {
		kind: 'split'
		atPanelId: string
		dir: 'row' | 'column'
		side: 'before' | 'after'
		newPanelId: string
	}

/**
 * Classify a pointer position (RELATIVE to the rect's top-left; `(0,0)` is the
 * corner) into a drop zone.
 *
 * Band thickness = `edgeFraction * min(width, height)` — a single symmetric band
 * width derived from the SHORTER side so a wide/short panel doesn't get an
 * absurdly fat horizontal band. A point in NO band is `center` (the tab-join
 * interior). A point in TWO bands (a corner) tie-breaks by NORMALIZED distance
 * to each active edge; on an exact tie HORIZONTAL wins. A point OUTSIDE the rect
 * clamps to the nearest edge zone (per-axis; diagonal corners pick the larger
 * overshoot, horizontal breaking ties).
 */
export function computeDropZone(
	rect: { width: number; height: number },
	point: { x: number; y: number },
	edgeFraction = 0.25,
): DropZone {
	const { width, height } = rect
	const { x, y } = point

	// ── DEGENERATE / NON-FINITE guard (N1) ─────────────────────────────────
	// A zero/negative/non-finite rect has no meaningful edge bands; a non-finite
	// point can't be classified. Treat either as the interior (tab-join). Note a
	// non-finite WIDTH/HEIGHT (e.g. Infinity) satisfies `> 0` and would otherwise
	// slip through — `band = ef * min(Infinity, h)` yields a finite band and the
	// point is misclassified as an EDGE zone — so reject finiteness EXPLICITLY.
	if (
		!(width > 0) || !(height > 0)
		|| !Number.isFinite(width) || !Number.isFinite(height)
		|| !Number.isFinite(x) || !Number.isFinite(y)
	) {
		return 'center'
	}
	// Clamp the band fraction to [0, 0.5] (N1): a fraction > 0.5 makes the left
	// and right bands (and top/bottom) OVERLAP, so a point near the right edge of
	// a narrow rect would satisfy BOTH `inLeft` and `inRight` and be misread as
	// `left`. Capping at 0.5 keeps the two bands disjoint.
	const ef = Number.isFinite(edgeFraction) ? Math.max(0, Math.min(0.5, edgeFraction)) : 0.25

	// ── OUT-OF-RECT clamp ──────────────────────────────────────────────────
	// A pointer dragged past the panel edge has no band membership; clamp it to
	// the nearest edge zone. Compute the signed per-axis overshoot: negative =
	// out the low side (left/top), positive = out the high side (right/bottom).
	const outX = x < 0 ? x : x > width ? x - width : 0
	const outY = y < 0 ? y : y > height ? y - height : 0
	if (outX !== 0 || outY !== 0) {
		const magX = Math.abs(outX)
		const magY = Math.abs(outY)
		// Both axes out (a diagonal corner): the axis with the LARGER overshoot
		// magnitude wins; an exact tie is broken by HORIZONTAL (the x axis).
		if (magX >= magY) {
			if (magX > 0) return outX < 0 ? 'left' : 'right'
		}
		// Only y out, or y overshoot strictly larger.
		return outY < 0 ? 'top' : 'bottom'
	}

	// ── BAND membership (in-rect) ──────────────────────────────────────────
	const band = ef * Math.min(width, height)
	const inLeft = x < band
	const inRight = x > width - band
	const inTop = y < band
	const inBottom = y > height - band

	const activeHoriz = inLeft || inRight
	const activeVert = inTop || inBottom

	// No band => interior => join the tab group.
	if (!activeHoriz && !activeVert) return 'center'

	// Single-axis band => that edge zone directly.
	if (activeHoriz && !activeVert) return inLeft ? 'left' : 'right'
	if (activeVert && !activeHoriz) return inTop ? 'top' : 'bottom'

	// ── CORNER tie-break (both axes active) ────────────────────────────────
	// Pick the edge with the SMALLER normalized distance. Only the ACTIVE
	// horizontal edge and ACTIVE vertical edge can compete (left vs right and
	// top vs bottom can't both be active for a sane rect). On an exact tie,
	// HORIZONTAL wins (`<=` on the horizontal distance).
	const dHoriz = inLeft ? x / width : (width - x) / width
	const dVert = inTop ? y / height : (height - y) / height
	if (dHoriz <= dVert) return inLeft ? 'left' : 'right'
	return inTop ? 'top' : 'bottom'
}

/**
 * Translate a drop zone into an engine-neutral re-dock descriptor.
 *
 *   center => move the dragged panel into the target's tab group.
 *   left/right => split the target panel horizontally (row), dragged before/after.
 *   top/bottom => split the target panel vertically (column), dragged before/after.
 */
export function dropZoneToMutation(
	zone: DropZone,
	dragged: string,
	target: { groupId: string; panelId: string },
): RedockMutation {
	if (zone === 'center') {
		return { kind: 'move', panelId: dragged, destGroupId: target.groupId }
	}
	const dir: 'row' | 'column' = zone === 'left' || zone === 'right' ? 'row' : 'column'
	const side: 'before' | 'after' = zone === 'left' || zone === 'top' ? 'before' : 'after'
	return { kind: 'split', atPanelId: target.panelId, dir, side, newPanelId: dragged }
}

/**
 * A re-dock is a NO-OP when it would not change the tree:
 *
 *   1. The drop targets the dragged panel ITSELF (`dragged === target.panelId`),
 *      in ANY zone — you can neither tab a panel onto its own tab nor split a
 *      panel around itself. Crucially this also guards the SPLIT case: without
 *      it, `extractPanel(dragged)` then `splitPanel(atPanelId = dragged)` removes
 *      the very anchor it then splits at and THROWS (the self-collapse / single-
 *      panel-self-split bug).
 *   2. A `center` drop into a group the dragged panel ALREADY lives in
 *      (`draggedGroupId === target.groupId`) — `movePanel` would re-append it and
 *      bump the revision for no visible change (churn).
 *
 * A SPLIT onto a DIFFERENT panel of the dragged panel's own group is still a real
 * re-dock (it splits the group around that sibling), so it is NOT a no-op.
 *
 * `draggedGroupId` is the id of the tab group currently holding `dragged`
 * (`undefined` if it is not in the tree).
 */
export function isNoopRedock(
	dragged: string,
	draggedGroupId: string | undefined,
	target: { groupId: string; panelId: string },
	zone: DropZone,
): boolean {
	if (dragged === target.panelId) return true
	if (zone === 'center' && draggedGroupId !== undefined && draggedGroupId === target.groupId) {
		return true
	}
	return false
}

/**
 * Map a pointer x-position over a horizontal tab strip to an insertion index for
 * a within-strip REORDER (the `dropPolicy:'reorder-only'` gesture). The strip is
 * the dragged tab's own group; `tabRects` are the tab buttons' rects in visual
 * order (each `left` is the rect's left edge, `width` its width). The index is
 * the count of tabs whose MIDPOINT the pointer has passed: the LEFT half of a tab
 * inserts BEFORE it, the RIGHT half (and the exact midpoint) inserts AFTER it. A
 * pointer left of the first tab → 0; past the last tab → `tabRects.length`. Pure
 * (no DOM): the caller measures the rects and passes the pointer x. An empty
 * strip or a non-finite pointer → 0.
 */
export function computeReorderIndex(
	tabRects: readonly { left: number; width: number }[],
	pointerX: number,
): number {
	if (!Number.isFinite(pointerX)) return 0
	let index = 0
	for (const rect of tabRects) {
		const midpoint = rect.left + rect.width / 2
		if (pointerX >= midpoint) index += 1
		else break
	}
	return index
}

/**
 * Translate a tab strip's VISIBLE-tab drop index into the insertion index
 * `movePanel`'s same-group reorder expects.
 *
 * `computeReorderIndex` reports how many VISIBLE-tab midpoints the pointer has
 * passed (0..`visibleTabIds.length`), COUNTING the dragged tab's own midpoint and
 * measured over rects that OMIT `hideTab` panels. `movePanel` inserts into
 * `panels.filter(p => p !== dragged)` — a different coordinate space. Two shifts
 * reconcile them:
 *
 *   1. Once the pointer passes the dragged tab's OWN midpoint the strip index has
 *      counted the dragged slot, so drop it back out (−1) to get the insertion
 *      slot among the OTHER visible tabs.
 *   2. Map that visible slot onto the full `panels` order (which may carry hidden
 *      tabs the strip never measured): insert before whichever visible tab now
 *      occupies the slot, or append when the slot is past the last visible tab.
 */
export function resolveReorderInsertIndex(
	panels: readonly string[],
	visibleTabIds: readonly string[],
	draggedPanelId: string,
	stripInsertIndex: number,
): number {
	const draggedVisibleIndex = visibleTabIds.indexOf(draggedPanelId)
	const passedOwnMidpoint = draggedVisibleIndex >= 0 && stripInsertIndex > draggedVisibleIndex
	const filteredVisible = visibleTabIds.filter((id) => id !== draggedPanelId)
	const filteredPanels = panels.filter((id) => id !== draggedPanelId)

	let visibleInsert = passedOwnMidpoint ? stripInsertIndex - 1 : stripInsertIndex
	if (visibleInsert < 0) visibleInsert = 0
	if (visibleInsert > filteredVisible.length) visibleInsert = filteredVisible.length

	if (visibleInsert >= filteredVisible.length) return filteredPanels.length
	const anchor = filteredVisible[visibleInsert]!
	const anchorIndex = filteredPanels.indexOf(anchor)
	return anchorIndex >= 0 ? anchorIndex : filteredPanels.length
}
