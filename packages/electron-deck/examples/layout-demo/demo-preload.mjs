// electron-deck layout demo — preload.
//
// The ENTIRE hand-wired layout bridge (onSlotGrant/sendPlace/subscribe over
// hard-coded `DeckChannel.*` strings) is GONE. The framework now ships a turnkey
// helper: one call exposes `window.__electronDeckLayoutBridge`, wired to the real
// channels (names sourced from the framework's own `DeckChannel`, never hand-copied).
//
// This preload is ESM (`.mjs`) so it can `import` the helper straight from the
// framework's preload dist (which is ESM). Electron's ESM preload requires
// `sandbox: false` (set in main.mjs's mainWindowWebPreferences). The only thing
// left here is the demo's OWN control/screenshot plumbing — pure demo glue, not a
// framework gap.

import { contextBridge, ipcRenderer } from 'electron'
import { exposeDeckLayoutBridge } from '../../dist/preload/index.js'

// One line replaces the whole hand-wired layoutBridge + DeckChannel block.
// Exposes `window.__electronDeckLayoutBridge` (a real LayoutBridge).
exposeDeckLayoutBridge()

// The demo's OWN control channels (project open + composite screenshot machinery).
// These are pure demo plumbing, NOT a framework gap.
const demoControl = {
	openProject(id) {
		ipcRenderer.send('demo:open-project', id)
	},
	onSetLabel(cb) {
		ipcRenderer.on('demo:set-label', (_e, label, bg) => cb(label, bg))
	},
	onComposite(cb) {
		ipcRenderer.on('demo:composite', (_e, reqId, hostPng, blocks) => cb(reqId, hostPng, blocks))
	},
	sendCompositeResult(reqId, dataUrl) {
		ipcRenderer.send('demo:composite-result', reqId, dataUrl)
	},
}

contextBridge.exposeInMainWorld('__demoControl', demoControl)
