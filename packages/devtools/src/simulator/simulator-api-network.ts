/**
 * DevTools API stubs for network-related wx.xxx APIs.
 *
 * Each exported function is bound with `this` = MiniApp instance
 * (via AppManager.registerApi -> MiniApp.invokeApi).
 */

import type { MiniAppContext } from './types'
import { bindCallbacks } from './simulator-api-helpers'
import { createTempFilePath, getTempFileName, resolveTempFilePath } from './temp-files'

export function downloadFile(
	this: MiniAppContext,
	{ url, header = {}, filePath, success, fail, complete }: {
		url: string
		header?: Record<string, string>
		filePath?: string
		success?: unknown
		fail?: unknown
		complete?: unknown
	},
) {
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })

	fetch(url, { headers: header })
		.then(async (response) => {
			if (!response.ok) throw new Error(response.statusText)
			const blob = await response.blob()
			const tempFilePath = createTempFilePath(blob)
			onSuccess?.({
				tempFilePath,
				filePath: filePath || tempFilePath,
				statusCode: response.status,
				errMsg: 'downloadFile:ok',
			})
		})
		.catch((error: Error) => {
			onFail?.({ errMsg: `downloadFile:fail ${error.message}` })
		})
		.finally(() => {
			onComplete?.()
		})
}

type UploadFileOptions = {
	url: string
	filePath: string
	name: string
	header?: Record<string, string>
	formData?: Record<string, unknown>
	timeout?: number
	uploadId?: string
	progress?: unknown
	headersReceived?: unknown
	success?: unknown
	fail?: unknown
	complete?: unknown
}

const uploadRequests = new Map<string, XMLHttpRequest>()
const uploadPendingResolves = new Set<string>()
const uploadAbortedBeforeStart = new Set<string>()
let nextUploadId = 1

function createUploadId(): string {
	return `upload_${Date.now()}_${nextUploadId++}`
}

function parseResponseHeaders(raw: string): Record<string, string> {
	const headers: Record<string, string> = {}
	for (const line of raw.trim().split(/[\r\n]+/)) {
		if (!line) continue
		const index = line.indexOf(':')
		if (index <= 0) continue
		const key = line.slice(0, index).trim()
		const value = line.slice(index + 1).trim()
		if (key) headers[key] = value
	}
	return headers
}

function appendFormData(form: FormData, formData: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(formData)) {
		if (value == null) continue
		if (value instanceof Blob) {
			form.append(key, value)
		} else if (typeof value === 'object') {
			// JSON.stringify for plain objects/arrays; Map/Set/RegExp/TypedArray
			// fall through here too and become '{}' or similar — caller should
			// pre-stringify if they need a specific form.
			form.append(key, JSON.stringify(value))
		} else {
			form.append(key, String(value))
		}
	}
}

export function uploadFile(
	this: MiniAppContext,
	{
		url,
		filePath,
		name,
		header = {},
		formData = {},
		timeout,
		uploadId = createUploadId(),
		progress,
		headersReceived,
		success,
		fail,
		complete,
	}: UploadFileOptions,
) {
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	const onProgress = this.createCallbackFunction(progress)
	const onHeadersReceived = this.createCallbackFunction(headersReceived)

	const cleanup = () => {
		uploadRequests.delete(uploadId)
		uploadPendingResolves.delete(uploadId)
		uploadAbortedBeforeStart.delete(uploadId)
	}
	const finishFail = (message: string) => {
		cleanup()
		const result = { errMsg: `uploadFile:fail ${message}` }
		onFail?.(result)
		onComplete?.(result)
	}

	uploadPendingResolves.add(uploadId)
	void resolveTempFilePath(filePath)
		.then((blob) => {
			uploadPendingResolves.delete(uploadId)
			if (uploadAbortedBeforeStart.has(uploadId)) {
				finishFail('abort')
				return
			}

			const xhr = new XMLHttpRequest()
			let settled = false
			let deliveredHeaders = false
			uploadRequests.set(uploadId, xhr)

			const finishSuccess = () => {
				if (settled) return
				settled = true
				const headers = parseResponseHeaders(xhr.getAllResponseHeaders())
				cleanup()
				const result = {
					data: typeof xhr.response === 'string' ? xhr.response : xhr.responseText,
					statusCode: xhr.status,
					header: headers,
					errMsg: 'uploadFile:ok',
				}
				onSuccess?.(result)
				onComplete?.(result)
			}
			const finishXhrFail = (message: string) => {
				if (settled) return
				settled = true
				finishFail(message)
			}
			const emitHeaders = () => {
				if (deliveredHeaders) return
				deliveredHeaders = true
				onHeadersReceived?.({ header: parseResponseHeaders(xhr.getAllResponseHeaders()) })
			}

			xhr.open('POST', url, true)
			if (timeout === undefined) {
				xhr.timeout = 60_000
			} else if (Number(timeout) > 0) {
				xhr.timeout = Number(timeout)
			}
			for (const [key, value] of Object.entries(header)) {
				if (/^(referer|content-type)$/i.test(key)) continue
				xhr.setRequestHeader(key, String(value))
			}
			xhr.upload.onprogress = (event) => {
				const totalBytesExpectedToSend = event.lengthComputable ? event.total : blob.size
				const progressValue = totalBytesExpectedToSend > 0
					? Math.round((event.loaded / totalBytesExpectedToSend) * 100)
					: 0
				onProgress?.({
					progress: Math.max(0, Math.min(100, progressValue)),
					totalBytesSent: event.loaded,
					totalBytesExpectedToSend,
				})
			}
			xhr.onreadystatechange = () => {
				if (xhr.readyState >= XMLHttpRequest.HEADERS_RECEIVED) emitHeaders()
			}
			xhr.onload = () => {
				emitHeaders()
				finishSuccess()
			}
			xhr.onerror = () => finishXhrFail('network error')
			xhr.ontimeout = () => finishXhrFail('timeout')
			xhr.onabort = () => finishXhrFail('abort')

			const body = new FormData()
			appendFormData(body, formData)
			body.append(name, blob, getTempFileName(filePath, blob, name || 'file'))
			xhr.send(body)
		})
		.catch((error: Error) => {
			finishFail(error.message)
		})
}

export function uploadFileAbort(this: MiniAppContext, { uploadId }: { uploadId?: string } = {}) {
	if (!uploadId) return
	const xhr = uploadRequests.get(uploadId)
	if (xhr) {
		xhr.abort()
		return
	}
	if (uploadPendingResolves.has(uploadId)) {
		uploadAbortedBeforeStart.add(uploadId)
	}
}
