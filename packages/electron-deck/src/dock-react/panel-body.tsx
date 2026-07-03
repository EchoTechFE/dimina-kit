/**
 * Tab-group body rendering under DOM-panel keepalive: `renderActiveBody` (the
 * body region) + `NativeSlot` (the anchor for an active native panel).
 */
import { Fragment, useCallback, useRef, type ReactNode } from 'react'
import type { TabGroupNode } from '../layout/index.js'
import type { RenderContext } from './dock-view.js'

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
export function renderActiveBody(node: TabGroupNode, ctx: RenderContext): ReactNode {
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
	// Bodies are absolutely stacked and inactive ones are `display:none`, so their
	// DOM sibling order carries no visual meaning. Render them in a STABLE order
	// (by panelId) rather than tab order: a tab reorder must not move a body's DOM
	// node, because a web host renders bodies as iframes and moving an iframe node
	// reloads it. The `key` stays panel-stable so activation never remounts a body.
	const domBodies = node.panels
		.filter((panelId) => ctx.registry.get(panelId)?.kind !== 'native')
		.slice()
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
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
