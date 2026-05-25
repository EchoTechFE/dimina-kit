/**
 * Mutators for the shared {@link TempFileStore}. The renderer-side bridge
 * forwards every `createTempFilePath` / `registerTempFilePath` /
 * `revokeTempFilePath` / `revokeAllTempFilePaths` call over IPC, and these
 * helpers translate the payloads into Map writes.
 *
 * ArrayBuffer inputs are normalised to Buffer at the boundary so the
 * resolver hot path can return the bytes directly without re-wrapping.
 */

import type { TempFileStore } from './resolver.js'

export function registerTempFile(
	store: TempFileStore,
	path: string,
	mime: string,
	bytes: ArrayBuffer | Buffer,
): void {
	const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(new Uint8Array(bytes))
	// delete-then-set so an existing entry's insertion order is refreshed.
	// Without this, a FIFO cap eviction over `store.keys()` could drop a
	// recently re-written path.
	store.delete(path)
	store.set(path, { bytes: buf, mime })
}

export function revokeTempFile(store: TempFileStore, path: string): void {
	store.delete(path)
}

export function revokeAllTempFiles(store: TempFileStore): void {
	store.clear()
}
