// electron-deck DOCKABLE demo — renderer React app (bundled to app.bundle.js).
//
// This is the NEW deliverable: the renderer DOM is driven entirely by the
// React `<DockView>` dock-shell adapter (src/dock-react). DockView renders a
// layout-as-data tree (createLayoutModel) as react-resizable-panels groups +
// DOM tab strips, and for native panels renders an empty
// `<div data-deck-native-slot="simulator">`. The host (main.mjs) places a
// native WebContentsView anchored to that exact selector via
// `runtime.view().placeIn(win, { anchor })`; the real createDeckLayoutClient
// measures the slot and the native view FOLLOWS it — zero host resize code.
//
// All structural / state wiring uses ONLY the consumed public API:
//   createLayoutModel / createPanelRegistry / mutations / serialize  (src/layout)
//   <DockView>                                                        (src/dock-react)
//   createDeckLayoutClient                                            (src/client)
// We do NOT modify those packages.

import React from 'react'
import { createRoot } from 'react-dom/client'
// Import the BUILT dist (relative) — the example lives inside the package and
// the package is not symlinked for self-import, mirroring layout-demo. esbuild
// bundles react/react-dom + these into a single browser IIFE (app.bundle.js).
import {
	createLayoutModel,
	createPanelRegistry,
	setActive,
	movePanel,
	serializeLayout,
	parseLayout,
	validateTree,
} from '../../dist/layout/index.js'
import { DockView } from '../../dist/dock-react/index.js'
import { createDeckLayoutClient } from '../../dist/client/index.js'

// ── the layout-as-data tree under test ───────────────────────────────────────
// root split[row] of:
//   tabs g-left  (['simulator'], native active)
//   tabs g-right (['editor','logs'], dom, editor active)
function makeTree() {
	return {
		version: 1,
		root: {
			kind: 'split',
			id: 'root',
			orientation: 'row',
			sizes: [1, 1],
			children: [
				{ kind: 'tabs', id: 'g-left', panels: ['simulator'], active: 'simulator' },
				{ kind: 'tabs', id: 'g-right', panels: ['editor', 'logs'], active: 'editor' },
			],
		},
	}
}

function makeRegistry() {
	const reg = createPanelRegistry()
	// native simulator — nativeRef.id = 'sim' (host maps this to a real WCV).
	reg.register({ kind: 'native', id: 'simulator', title: 'Simulator', nativeRef: { id: 'sim' } })
	reg.register({ kind: 'dom', id: 'editor', title: 'Editor' })
	reg.register({ kind: 'dom', id: 'logs', title: 'Logs' })
	return reg
}

// DOM body content for the dom panels (editor / logs). A stable marker per
// panel so the host can assert which body is mounted via data-test-dom-content.
function renderDomPanel(panelId) {
	const text =
		panelId === 'editor'
			? '// editor panel — dom body'
			: panelId === 'logs'
				? '> logs panel — dom body'
				: panelId
	return React.createElement(
		'div',
		{ 'data-test-dom-content': panelId, className: 'dom-body' },
		text,
	)
}

// ── the renderer's only host-coupling: bind the native slot to the real client ──
// The deck layout client measures the slot purely by selector (querySelector on
// grant). Our job: (1) ensure the native block is placed (open the project)
// once the slot first mounts; (2) on every (re)mount/move, ask the host to
// REPLAY the grant so the (possibly newly-mounted) slot re-anchors. The
// view-anchor inside the client owns the ResizeObserver → it re-publishes when
// the slot rect changes, so geometry following is automatic.
let opened = false
function makeBindNativeSlot(bridge, demo) {
	return (panelId, el) => {
		if (panelId !== 'simulator') return
		if (el) {
			if (!opened) {
				opened = true
				demo.openProject('dockable')
			} else {
				// re-mounted (e.g. after restore / tab toggle): replay grants so the
				// client re-resolves this fresh slot element and re-anchors.
				bridge.subscribe()
			}
		}
	}
}

// ── mount a DockView for a given model; returns { root, unmount } ─────────────
function mountDock(containerEl, model, registry, bindNativeSlot) {
	const root = createRoot(containerEl)
	root.render(
		React.createElement(DockView, {
			model,
			registry,
			renderDomPanel,
			bindNativeSlot,
		}),
	)
	return root
}

// ─────────────────────────────────────────────────────────────────────────────
function boot() {
	const bridge = window.__electronDeckLayoutBridge
	const demo = window.__demoControl

	// REAL slot-token client — owns ZERO geometry/IPC beyond a bridge. It
	// measures whatever DOM element matches the granted slot selector.
	createDeckLayoutClient({ bridge })

	const dockHost = document.getElementById('dock-host')
	const registry = makeRegistry()
	let model = createLayoutModel(makeTree())
	const bindNativeSlot = makeBindNativeSlot(bridge, demo)
	let root = mountDock(dockHost, model, registry, bindNativeSlot)

	// Expose model + helpers to the offscreen verification driver (executeJS).
	window.__deck = {
		// current model accessor (re-pointed after restore)
		model: () => model,
		registry,
		serializeLayout,
		// Resize the dock host so rrp re-distributes the left (simulator) panel.
		// The native slot's rect changes → view-anchor re-publishes → native WCV
		// follows. This is renderer-driven geometry: the host writes NO bounds.
		setHostWidth: (px) => {
			dockHost.style.width = px + 'px'
		},
		// Read the active panel of a group from the canonical model tree.
		activeOf: (groupId) => {
			const find = (n) =>
				n.kind === 'tabs'
					? n.id === groupId
						? n
						: null
					: n.children.map(find).find(Boolean) || null
			const g = find(model.get().root)
			return g ? g.active : null
		},
		// Serialize → teardown → parse+validate → rebuild a FRESH model+DockView.
		// Proves persistence round-trips through the public serialize surface and
		// the restored DOM reflects the persisted tree.
		serializeRestore: () => {
			const json = serializeLayout(model.get())
			// teardown the live dock
			root.unmount()
			// parse + validate against the registry's known panel ids
			const knownIds = new Set(registry.list().map((p) => p.id))
			const tree = parseLayout(json)
			const problems = validateTree(tree, knownIds)
			if (problems.length) {
				return { ok: false, problems, json }
			}
			// rebuild a fresh model + DockView from the persisted tree
			opened = true // native block is already placed; just replay on re-mount
			model = createLayoutModel(tree)
			root = mountDock(dockHost, model, registry, bindNativeSlot)
			return { ok: true, json }
		},
		// Programmatic move: relocate 'logs' to the LEFT group (cross-group move)
		// purely through the model mutation API. DockView re-renders from the
		// model subscription.
		moveLogsLeft: () => {
			model.apply((t) => movePanel(t, 'logs', { groupId: 'g-left' }))
		},
		setActive: (groupId, panelId) => {
			model.apply((t) => setActive(t, groupId, panelId))
		},
	}

	// ── composite-screenshot machinery (REUSED from layout-demo) ──────────────
	demo.onComposite(async (reqId, hostPng, blocks) => {
		const load = (src) =>
			new Promise((res) => {
				const i = new Image()
				i.onload = () => res(i)
				i.src = src
			})
		const hostImg = await load(hostPng)
		const c = document.createElement('canvas')
		c.width = hostImg.naturalWidth
		c.height = hostImg.naturalHeight
		const sx = hostImg.naturalWidth / window.innerWidth
		const sy = hostImg.naturalHeight / window.innerHeight
		const ctx = c.getContext('2d')
		ctx.drawImage(hostImg, 0, 0)
		for (const b of blocks) {
			const img = await load(b.png)
			ctx.drawImage(img, b.x * sx, b.y * sy, b.width * sx, b.height * sy)
		}
		demo.sendCompositeResult(reqId, c.toDataURL('image/png'))
	})

	// Signal readiness to the host so the verification driver can begin.
	demo.ready()
}

boot()
