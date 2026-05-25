/**
 * Devtools simulator temp-file registry.
 *
 * The simulator hands `chooseImage` / `chooseMedia` / `chooseVideo` /
 * `compressImage` etc. results back to mini-program code as paths. Historically
 * those paths were `blob:` URLs allocated via `URL.createObjectURL`, but the
 * blob: scheme is local-to-the-renderer and cannot be served back into the
 * webview's `persist:simulator` session through a `protocol.handle`. We switched
 * to a custom `difile://_tmp/{uuid}` scheme so the main process can
 * register a single `difile://` protocol handler and stream the bytes for any
 * path, regardless of which renderer originally produced it.
 *
 * To keep the renderer-side cache and the main-process byte store in sync,
 * `setTempFileSink` lets the preload bridge inject a sink that mirrors every
 * `write` / `revoke` / `revokeAll` over IPC. Tests inject a stub sink.
 */

export interface TempFileSink {
	write(path: string, blob: Blob): void
	revoke(path: string): void
	revokeAll(): void
}

const tempFiles = new Map<string, Blob>()
let activeSink: TempFileSink | null = null

export function setTempFileSink(sink: TempFileSink | null): void {
	activeSink = sink
}

function cryptoRandomId(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
	if (c && typeof c.randomUUID === 'function') return c.randomUUID()
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function createTempFilePath(blob: Blob): string {
	const path = `difile://_tmp/${cryptoRandomId()}`
	tempFiles.set(path, blob)
	activeSink?.write(path, blob)
	return path
}

export function registerTempFilePath(path: string, blob: Blob): void {
	tempFiles.set(path, blob)
	activeSink?.write(path, blob)
}

export function revokeTempFilePath(path: string): void {
	tempFiles.delete(path)
	activeSink?.revoke(path)
}

export function revokeAllTempFilePaths(): void {
	tempFiles.clear()
	activeSink?.revokeAll()
}

export async function resolveTempFilePath(path: string): Promise<Blob> {
	const cached = tempFiles.get(path)
	if (cached) return cached

	const response = await fetch(path)
	if (!response.ok) {
		throw new Error(`无法读取文件 ${path}`)
	}
	const blob = await response.blob()
	// Cache the freshly fetched blob in-memory so subsequent reads are local.
	// We bypass `registerTempFilePath` deliberately: this is a renderer-only
	// cache fill, the main-process store already has the bytes (otherwise the
	// fetch would not have returned them), so triggering sink.write would
	// produce a redundant IPC.
	tempFiles.set(path, blob)
	return blob
}

export function getTempFileName(path: string, blob: Blob, fallback = 'file'): string {
	const named = blob as Blob & { name?: unknown }
	if (typeof named.name === 'string' && named.name.trim()) {
		return named.name
	}

	try {
		const url = new URL(path, window.location.href)
		const segment = url.pathname.split('/').filter(Boolean).pop()
		if (segment) return decodeURIComponent(segment)
	} catch {
		// Fall through to the caller-provided fallback.
	}

	return fallback
}
