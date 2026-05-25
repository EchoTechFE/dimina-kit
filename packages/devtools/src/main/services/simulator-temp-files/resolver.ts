/**
 * Pure lookup helper backing the main-process `difile://_tmp/*` protocol
 * handler. Receives the shared {@link TempFileStore} that the
 * `simulator:temp-file:*` IPC channels populate from the renderer.
 *
 * The full URL (including scheme + host) is used as the Map key — the resolver
 * never re-parses or normalises it, so any URL with a wrong scheme or host
 * misses regardless of suffix similarity.
 */

export interface TempFileRecord {
	bytes: Buffer
	mime: string
}

export type TempFileStore = Map<string, TempFileRecord>

export function resolveTempFile(
	store: TempFileStore,
	url: string,
): { status: 200; bytes: Buffer; mime: string } | { status: 404 } {
	if (!url.startsWith('difile://_tmp/')) return { status: 404 }
	const record = store.get(url)
	if (!record) return { status: 404 }
	return {
		status: 200,
		bytes: record.bytes,
		mime: record.mime || 'application/octet-stream',
	}
}
