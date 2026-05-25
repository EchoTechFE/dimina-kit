/**
 * Preload-side bridge that mirrors the simulator's renderer-side temp-file
 * registry into the main-process store via IPC. The main process serves the
 * resulting `difile://devtools/{uuid}` URLs over a protocol handler bound to
 * the simulator session.
 */

import { ipcRenderer } from 'electron'
import { setTempFileSink } from '../../simulator/temp-files.js'

export function installTempFileBridge(): void {
	setTempFileSink({
		write(path, blob) {
			blob
				.arrayBuffer()
				.then((bytes) => {
					ipcRenderer.send('simulator:temp-file:write', {
						path,
						mime: blob.type,
						bytes,
					})
				})
				.catch(() => {
					// best effort: blob read failures cannot be surfaced through the
					// sink contract (`write` is sync void), so we swallow them.
				})
		},
		revoke(path) {
			ipcRenderer.send('simulator:temp-file:revoke', { path })
		},
		revokeAll() {
			ipcRenderer.send('simulator:temp-file:revoke-all')
		},
	})
}
