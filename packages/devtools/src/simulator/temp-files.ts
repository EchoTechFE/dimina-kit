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
	writeAndWait?(path: string, blob: Blob): Promise<void>
	revoke(path: string): void
	revokeAll(): void
}

/**
 * 和主进程那份存储用同一个上限（dimina-electron-runtime 的 `MAX_STORE_ENTRIES`），同样按
 * 插入顺序淘汰。renderer 这份只是同一批字节的副本：主进程超出上限就把老的扔了，这边留更多
 * 份也读不出别的东西，只是白占内存——一次 canvas 导出就可能有 32MB。被淘汰的路径下次读会
 * 走 fetch 回主进程，拿不到才算真的过期。
 */
const MAX_TEMP_FILE_ENTRIES = 200

const tempFiles = new Map<string, Blob>()
let activeSink: TempFileSink | null = null

function rememberTempFile(path: string, blob: Blob): void {
	tempFiles.set(path, blob)
	while (tempFiles.size > MAX_TEMP_FILE_ENTRIES) {
		const oldest = tempFiles.keys().next()
		if (oldest.done) break
		tempFiles.delete(oldest.value)
	}
}

export function setTempFileSink(sink: TempFileSink | null): void {
	activeSink = sink
}

function cryptoRandomId(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
	if (c && typeof c.randomUUID === 'function') return c.randomUUID()
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function allocateTempFilePath(blob: Blob): string {
	const path = `difile://_tmp/${cryptoRandomId()}`
	rememberTempFile(path, blob)
	return path
}

export function createTempFilePath(blob: Blob): string {
	const path = allocateTempFilePath(blob)
	activeSink?.write(path, blob)
	return path
}

/**
 * 返回路径前等待主进程确认字节已经登记。需要“成功回调后路径立即可读”的 API 使用此入口；
 * 旧的同步创建入口保持不变，避免改变 chooseImage 等现有 API 的签名。
 */
export async function createTempFilePathAsync(blob: Blob): Promise<string> {
	const path = allocateTempFilePath(blob)
	try {
		if (activeSink?.writeAndWait) {
			await activeSink.writeAndWait(path, blob)
		}
		else {
			activeSink?.write(path, blob)
		}
	}
	catch (error) {
		// 写入没成功，这个路径就永远不会交到小程序手里，也就没有人再来 revoke 它。
		// 留着 renderer 侧这份副本只会一直占内存——canvas 导出单份就可能有 32MB。
		tempFiles.delete(path)
		throw error
	}
	return path
}

export function registerTempFilePath(path: string, blob: Blob): void {
	rememberTempFile(path, blob)
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
	rememberTempFile(path, blob)
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
