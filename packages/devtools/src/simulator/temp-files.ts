const tempFiles = new Map<string, Blob>()

export function createTempFilePath(blob: Blob): string {
	const path = URL.createObjectURL(blob)
	tempFiles.set(path, blob)
	return path
}

export function registerTempFilePath(path: string, blob: Blob): void {
	tempFiles.set(path, blob)
}

export async function resolveTempFilePath(path: string): Promise<Blob> {
	const cached = tempFiles.get(path)
	if (cached) return cached

	const response = await fetch(path)
	if (!response.ok) {
		throw new Error(`无法读取文件 ${path}`)
	}
	const blob = await response.blob()
	registerTempFilePath(path, blob)
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
