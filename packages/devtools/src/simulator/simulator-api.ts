/**
 * DevTools API stubs for wx.xxx APIs that exist on native platforms
 * (iOS / Android / Harmony) but are missing in the web container.
 *
 * Each exported function is bound with `this` = MiniApp instance
 * (via AppManager.registerApi → MiniApp.invokeApi).
 */

import type { MiniAppContext } from './types'
import { bindCallbacks } from './simulator-api-helpers'
import { getTempFileName, resolveTempFilePath } from './temp-files'
import {
	setStorageSync,
	getStorageSync,
	removeStorageSync,
	clearStorageSync,
	getStorageInfoSync,
	setStorage,
	getStorage,
	removeStorage,
	clearStorage,
	getStorageInfo,
} from './simulator-api-storage'
import {
	hideKeyboard,
	adjustPosition,
	makePhoneCall,
	chooseContact,
	addPhoneContact,
	vibrateShort,
	vibrateLong,
	scanCode,
} from './simulator-api-device'
import {
	chooseImage,
	previewImage,
	compressImage,
	saveImageToPhotosAlbum,
	getImageInfo,
	chooseMedia,
	chooseVideo,
	audioCreate,
	audioListen,
	audioSetProp,
	audioPlay,
	audioPause,
	audioStop,
	audioSeek,
	audioDestroy,
} from './simulator-api-media'
import {
	fsAccess,
	fsStat,
	fsReadFile,
	fsWriteFile,
	fsAppendFile,
	fsCopyFile,
	fsRename,
	fsUnlink,
	fsMkdir,
	fsRmdir,
	fsReaddir,
	fsGetFileInfo,
	fsSaveFile,
	fsGetSavedFileList,
	fsRemoveSavedFile,
	fsTruncate,
	fsUnzip,
} from './simulator-api-fs'

// ─── Base ────────────────────────────────────────────────────────────────────

export function canIUse(this: MiniAppContext, { success, complete }: { success?: unknown; complete?: unknown }) {
	const { onSuccess, onComplete } = bindCallbacks(this, { success, complete })
	// In devtools all standard APIs are considered available.
	onSuccess?.(true)
	onComplete?.()
	// Also return synchronously for callers that use the return value.
	return true
}

export function getWindowInfo(this: MiniAppContext, { success, complete }: { success?: unknown; complete?: unknown } = {}) {
	const { onSuccess, onComplete } = bindCallbacks(this, { success, complete })

	const { wb, di, pixelRatio, screenWidth, screenHeight, windowWidth, windowHeight } = readWindowMetrics(this)
	const bar = this.parent?.getStatusBarRect?.() ?? { height: 0 }
	const statusBarHeight = (di['statusBarHeight'] as number | undefined) ?? bar.height

	const info = {
		pixelRatio, screenWidth, screenHeight, windowWidth, windowHeight,
		statusBarHeight,
		safeArea: {
			width: wb.width,
			height: wb.height - statusBarHeight,
			top: statusBarHeight,
			bottom: wb.height,
			left: 0,
			right: wb.width,
		},
	}
	onSuccess?.(info)
	onComplete?.()
	return info
}

export function getSystemSetting(this: MiniAppContext, { success, complete }: { success?: unknown; complete?: unknown } = {}) {
	const { onSuccess, onComplete } = bindCallbacks(this, { success, complete })

	const info = {
		bluetoothEnabled: false,
		locationEnabled: true,
		wifiEnabled: true,
		deviceOrientation: 'portrait',
	}
	onSuccess?.(info)
	onComplete?.()
	return info
}

// ─── System Info ─────────────────────────────────────────────────────────────

function readWindowMetrics(miniApp: MiniAppContext) {
	const wb = miniApp.parent?.el?.querySelector('.dimina-native-webview__root')?.getBoundingClientRect()
		?? { width: 375, height: 812 }
	const di = (window as Window & { __deviceInfo?: Record<string, number | string> }).__deviceInfo || {}
	return {
		wb,
		di,
		pixelRatio: (di['pixelRatio'] as number | undefined) || window.devicePixelRatio || 2,
		screenWidth: (di['screenWidth'] as number | undefined) || wb.width,
		screenHeight: (di['screenHeight'] as number | undefined) || wb.height,
		windowWidth: wb.width,
		windowHeight: wb.height,
	}
}

function buildSystemInfo(miniApp: MiniAppContext) {
	const { wb, di, pixelRatio, screenWidth, screenHeight, windowWidth, windowHeight } = readWindowMetrics(miniApp)
	const statusBarHeight = (di['statusBarHeight'] as number | undefined) ?? 0
	const safeAreaBottom = (di['safeAreaBottom'] as number | undefined) ?? 0

	return {
		brand: di['brand'] || 'devtools',
		model: di['model'] || 'devtools',
		pixelRatio, screenWidth, screenHeight, windowWidth, windowHeight,
		statusBarHeight,
		language: 'zh_CN',
		version: '8.0.5',
		system: di['system'] || 'iOS 16.0',
		platform: di['platform'] || 'ios',
		fontSizeSetting: 16,
		SDKVersion: '3.0.0',
		deviceOrientation: 'portrait',
		safeArea: {
			width: wb.width,
			height: wb.height - statusBarHeight - safeAreaBottom,
			top: statusBarHeight,
			bottom: wb.height - safeAreaBottom,
			left: 0,
			right: wb.width,
		},
	}
}

export function getSystemInfoAsync(this: MiniAppContext, opts: { success?: unknown; complete?: unknown }) {
	const { success, complete } = opts
	const { onSuccess, onComplete } = bindCallbacks(this, { success, complete })
	onSuccess?.(buildSystemInfo(this))
	onComplete?.()
}

export function getSystemInfo(this: MiniAppContext, opts: { success?: unknown; complete?: unknown }) {
	getSystemInfoAsync.call(this, opts)
}

export function getSystemInfoSync(this: MiniAppContext) {
	return buildSystemInfo(this)
}

// ─── Network ─────────────────────────────────────────────────────────────────

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
			const tempFilePath = URL.createObjectURL(blob)
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
		timeout = 0,
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

	const finishFail = (message: string) => {
		uploadRequests.delete(uploadId)
		uploadAbortedBeforeStart.delete(uploadId)
		onFail?.({ errMsg: `uploadFile:fail ${message}` })
		onComplete?.()
	}

	void resolveTempFilePath(filePath)
		.then((blob) => {
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
				uploadRequests.delete(uploadId)
				onSuccess?.({
					data: typeof xhr.response === 'string' ? xhr.response : xhr.responseText,
					statusCode: xhr.status,
					header: headers,
					errMsg: 'uploadFile:ok',
				})
				onComplete?.()
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
			if (Number(timeout) > 0) xhr.timeout = Number(timeout)
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
	uploadAbortedBeforeStart.add(uploadId)
}

// ─── Open API: Account Info ─────────────────────────────────────────────────

export function getAccountInfoSync(this: MiniAppContext) {
	return {
		miniProgram: {
			appId: this.appId || '',
			envVersion: 'develop',
			version: '',
		},
	}
}

// ─── Collect all APIs into a map ─────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const simulatorApis: Record<string, (this: MiniAppContext, opts: any) => unknown> = {
	// Base
	canIUse,
	getSystemInfo,
	getSystemInfoAsync,
	getSystemInfoSync,
	getWindowInfo,
	getSystemSetting,
	// Network
	downloadFile,
	uploadFile,
	uploadFileAbort,
	// Storage (sync)
	setStorageSync,
	getStorageSync,
	removeStorageSync,
	clearStorageSync,
	getStorageInfoSync,
	// Storage (async)
	setStorage,
	getStorage,
	removeStorage,
	clearStorage,
	getStorageInfo,
	// Open API
	getAccountInfoSync,
	// Device
	hideKeyboard,
	adjustPosition,
	makePhoneCall,
	chooseContact,
	addPhoneContact,
	vibrateShort,
	vibrateLong,
	scanCode,
	// Media: Image
	chooseImage,
	previewImage,
	compressImage,
	saveImageToPhotosAlbum,
	getImageInfo,
	// Media: Video
	chooseMedia,
	chooseVideo,
	// Media: Audio (service-apis/audio)
	audioCreate,
	audioListen,
	audioSetProp,
	audioPlay,
	audioPause,
	audioStop,
	audioSeek,
	audioDestroy,
	// Filesystem (service-apis/file)
	fsAccess,
	fsStat,
	fsReadFile,
	fsWriteFile,
	fsAppendFile,
	fsCopyFile,
	fsRename,
	fsUnlink,
	fsMkdir,
	fsRmdir,
	fsReaddir,
	fsGetFileInfo,
	fsSaveFile,
	fsGetSavedFileList,
	fsRemoveSavedFile,
	fsTruncate,
	fsUnzip,
}
