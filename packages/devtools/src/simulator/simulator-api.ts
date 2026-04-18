/**
 * DevTools API stubs for wx.xxx APIs that exist on native platforms
 * (iOS / Android / Harmony) but are missing in the web container.
 *
 * Each exported function is bound with `this` = MiniApp instance
 * (via AppManager.registerApi → MiniApp.invokeApi).
 */

import type { MiniAppContext } from './types'
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
	__audio_create,
	__audio_setProp,
	__audio_call,
	audioCreate,
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
	const onSuccess = this.createCallbackFunction(success)
	const onComplete = this.createCallbackFunction(complete)
	// In devtools all standard APIs are considered available.
	onSuccess?.(true)
	onComplete?.()
	// Also return synchronously for callers that use the return value.
	return true
}

export function getWindowInfo(this: MiniAppContext, { success, complete }: { success?: unknown; complete?: unknown } = {}) {
	const onSuccess = this.createCallbackFunction(success)
	const onComplete = this.createCallbackFunction(complete)

	const wb = this.parent?.el?.querySelector('.dimina-native-webview__root')?.getBoundingClientRect()
		?? { width: 375, height: 812 }
	const bar = this.parent?.getStatusBarRect?.() ?? { height: 0 }
	const di = (window as Window & { __deviceInfo?: Record<string, number | string> }).__deviceInfo || {}
	const statusBarHeight = (di['statusBarHeight'] as number | undefined) ?? bar.height

	const info = {
		pixelRatio: (di['pixelRatio'] as number | undefined) || window.devicePixelRatio || 2,
		screenWidth: (di['screenWidth'] as number | undefined) || wb.width,
		screenHeight: (di['screenHeight'] as number | undefined) || wb.height,
		windowWidth: wb.width,
		windowHeight: wb.height,
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
	const onSuccess = this.createCallbackFunction(success)
	const onComplete = this.createCallbackFunction(complete)

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

function buildSystemInfo(miniApp: MiniAppContext) {
	const wb = miniApp.parent?.el?.querySelector('.dimina-native-webview__root')?.getBoundingClientRect()
		?? { width: 375, height: 812 }
	const di = (window as Window & { __deviceInfo?: Record<string, number | string> }).__deviceInfo || {}
	const statusBarHeight = (di['statusBarHeight'] as number | undefined) ?? 0
	const safeAreaBottom = (di['safeAreaBottom'] as number | undefined) ?? 0

	return {
		brand: di['brand'] || 'devtools',
		model: di['model'] || 'devtools',
		pixelRatio: (di['pixelRatio'] as number | undefined) || window.devicePixelRatio || 2,
		screenWidth: (di['screenWidth'] as number | undefined) || wb.width,
		screenHeight: (di['screenHeight'] as number | undefined) || wb.height,
		windowWidth: wb.width,
		windowHeight: wb.height,
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
	const onSuccess = this.createCallbackFunction(success)
	const onComplete = this.createCallbackFunction(complete)
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
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)

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

export function uploadFile(
	this: MiniAppContext,
	{ fail, complete }: { url?: string; filePath?: string; name?: string; header?: unknown; formData?: unknown; success?: unknown; fail?: unknown; complete?: unknown },
) {
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)

	// In devtools we cannot truly access the filesystem; return a stub error.
	onFail?.({ errMsg: 'uploadFile:fail not supported in simulator' })
	onComplete?.()
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
	// Media: Audio (container-side, legacy __audio_* style)
	__audio_create,
	__audio_setProp,
	__audio_call,
	// Media: Audio (new-style, service-apis/audio)
	audioCreate,
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
