// electron-deck DOCKABLE demo — preload (mirrors layout-demo/demo-preload.mjs).
//
// One call exposes the turnkey `window.__electronDeckLayoutBridge` (real
// LayoutBridge, channels sourced from the framework's own DeckChannel). The
// rest is the demo's OWN control/screenshot plumbing — pure demo glue.

import { contextBridge, ipcRenderer } from 'electron'
import { exposeDeckLayoutBridge } from '../../dist/preload/index.js'

// Exposes `window.__electronDeckLayoutBridge`.
exposeDeckLayoutBridge()

const demoControl = {
	// renderer → host: open the project (host places the native simulator block).
	openProject(id) {
		ipcRenderer.send('demo:open-project', id)
	},
	// renderer → host: the React app has mounted + client is live; begin driving.
	ready() {
		ipcRenderer.send('demo:ready')
	},
	onComposite(cb) {
		ipcRenderer.on('demo:composite', (_e, reqId, hostPng, blocks) =>
			cb(reqId, hostPng, blocks),
		)
	},
	sendCompositeResult(reqId, dataUrl) {
		ipcRenderer.send('demo:composite-result', reqId, dataUrl)
	},
}

contextBridge.exposeInMainWorld('__demoControl', demoControl)
