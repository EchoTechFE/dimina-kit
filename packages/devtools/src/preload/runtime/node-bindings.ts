/**
 * Publishes real Node built-ins into the simulator document's shared JS
 * world (see shared/node-bindings for the consumer-side contract).
 *
 * The simulator WebContentsView runs nodeIntegration:false + sandbox:false +
 * contextIsolation:false: page scripts cannot require Node modules and the
 * vite bundle stubs `node:*` imports, but this preload shares the page's JS
 * world and has full Node access. The FileSystemManager backends and the
 * vpath resolver in the simulator bundle read these bindings.
 *
 * Trust boundary: this preload is assigned ONLY to the simulator top document
 * (devtools' own code) via webPreferences.preload — miniapp render guests and
 * the service host carry their own dedicated preloads, and no preload is
 * session-registered (`setPreloads` is unused repo-wide), so mini-program
 * code never sees these bindings.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import buffer from 'node:buffer'
import { NODE_BINDINGS_GLOBAL, type DiminaNodeBindings } from '../../shared/node-bindings.js'

export function installNodeBindings(): void {
	// contextIsolation:false means page scripts share this world: freeze the
	// bag (no member swap) and publish it non-writable AND non-configurable —
	// writable:false alone still leaves `delete` and a defineProperty
	// redefinition open to any same-world script, so the full lock needs
	// configurable:false too. A compromised page script then cannot
	// substitute a spoofed `fs` for the vpath resolver / FSM backends to
	// trust by any route.
	const existing = Object.getOwnPropertyDescriptor(globalThis, NODE_BINDINGS_GLOBAL)
	if (existing && !existing.configurable) {
		// Already locked (redefining a non-configurable property throws).
		return
	}
	const bindings: DiminaNodeBindings = Object.freeze({ fs, os, path, crypto, buffer })
	Object.defineProperty(globalThis, NODE_BINDINGS_GLOBAL, {
		value: bindings,
		writable: false,
		configurable: false,
		enumerable: true,
	})
}
