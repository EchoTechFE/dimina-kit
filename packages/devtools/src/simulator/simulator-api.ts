/**
 * DevTools API stubs for wx.xxx APIs that exist on native platforms
 * (iOS / Android / Harmony) but are missing in the web container.
 *
 * Each exported function is bound with `this` = MiniApp instance
 * (via AppManager.registerApi → MiniApp.invokeApi).
 */

import type { MiniAppContext } from './types'
import { bindCallbacks } from './simulator-api-helpers'
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
	getClipboardData,
	setClipboardData,
	getNetworkType,
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
import {
	downloadFile,
	uploadFile,
	uploadFileAbort,
} from './simulator-api-network'
export {
	downloadFile,
	uploadFile,
	uploadFileAbort,
} from './simulator-api-network'
import {
	showToast,
	hideToast,
	showLoading,
	hideLoading,
	showModal,
	showActionSheet,
} from './simulator-api-ui'

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

	const { wb, di, dev, pixelRatio, screenWidth, screenHeight, windowWidth, windowHeight } = readWindowMetrics(this)
	const bar = this.parent?.getStatusBarRect?.() ?? { height: dev?.statusBarHeight ?? 0 }
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
	// Priority unchanged: __deviceInfo → host DOM rect. Only the last-resort
	// fallback follows the CURRENTLY emulated device (SimulatorMiniApp tracks
	// boot config device + live DEVICE_CHANGE) instead of a hardcoded 375x812.
	const dev = miniApp.getDeviceMetrics?.()
	const wb = miniApp.parent?.el?.querySelector('.dimina-native-webview__root')?.getBoundingClientRect()
		?? { width: dev?.screenWidth ?? 375, height: dev?.screenHeight ?? 812 }
	const di = (window as Window & { __deviceInfo?: Record<string, unknown> }).__deviceInfo || {}
	return {
		wb,
		di,
		dev,
		pixelRatio: (di['pixelRatio'] as number | undefined) || dev?.pixelRatio || window.devicePixelRatio || 2,
		screenWidth: (di['screenWidth'] as number | undefined) || wb.width,
		screenHeight: (di['screenHeight'] as number | undefined) || wb.height,
		windowWidth: wb.width,
		windowHeight: wb.height,
	}
}

function buildSystemInfo(miniApp: MiniAppContext) {
	const { wb, di, dev, pixelRatio, screenWidth, screenHeight, windowWidth, windowHeight } = readWindowMetrics(miniApp)
	const statusBarHeight = (di['statusBarHeight'] as number | undefined) ?? dev?.statusBarHeight ?? 0
	// Bottom inset sourced from safeAreaInsets.bottom (the single source — the
	// legacy flat `safeAreaBottom` field is decommissioned).
	const bottomInset = (di['safeAreaInsets'] as { bottom?: number } | undefined)?.bottom
		?? dev?.safeAreaInsets?.bottom ?? 0

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
			height: wb.height - statusBarHeight - bottomInset,
			top: statusBarHeight,
			bottom: wb.height - bottomInset,
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

// `opts: never` (not the wider `unknown`) so every handler below — each typed
// with its OWN specific opts shape (`getSystemInfoAsync`'s `{ success?, complete? }`,
// `canIUse`'s `string`, …) — remains assignable into this map: a function
// parameter is checked contravariantly, and `never` is assignable into any
// concrete opts type, whereas `unknown` (the caller-side "any value" type)
// would reject every narrower handler signature here. Callers of this map
// always cast to a caller-appropriate handler type before invoking (see
// simulator-app.tsx / main-api-runner.ts) — this declaration only has to
// typecheck the object literal itself.
export const simulatorApis: Record<string, (this: MiniAppContext, opts: never) => unknown> = {
	// Base
	canIUse,
	getSystemInfo,
	getSystemInfoAsync,
	getSystemInfoSync,
	getWindowInfo,
	getSystemSetting,
	// UI: interaction
	showToast,
	hideToast,
	showLoading,
	hideLoading,
	showModal,
	showActionSheet,
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
	getClipboardData,
	setClipboardData,
	getNetworkType,
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
