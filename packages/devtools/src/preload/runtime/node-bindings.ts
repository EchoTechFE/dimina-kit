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
	// bag (no member swap) and publish it non-writable (no wholesale `=`
	// replacement), so a compromised page script cannot substitute a spoofed
	// `fs` for the vpath resolver / FSM backends to trust.
	const bindings: DiminaNodeBindings = Object.freeze({ fs, os, path, crypto, buffer })
	Object.defineProperty(globalThis, NODE_BINDINGS_GLOBAL, {
		value: bindings,
		writable: false,
		configurable: true,
		enumerable: true,
	})
}
