/**
 * DevTools API stubs for wx.xxx APIs that exist on native platforms
 * (iOS / Android / Harmony) but are missing in the web container.
 *
 * Each exported function is bound with `this` = MiniApp instance
 * (via AppManager.registerApi → MiniApp.invokeApi).
 */

import {
	normalizeDeviceOrientation,
	orientedDeviceMetrics,
	orientedSafeAreaInsets,
} from '@dimina-kit/electron-runtime/shared/page-orientation'
import type { DeviceMetrics, MiniAppContext } from './types'
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
import { fileSystemManagerApis } from './simulator-api-fsm'
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

	const { wb, di, dev, pixelRatio, windowWidth, windowHeight } = readWindowMetrics(this)
	const bar = this.parent?.getStatusBarRect?.() ?? { height: dev?.statusBarHeight ?? 0 }
	const portraitStatusBarHeight = (di['statusBarHeight'] as number | undefined) ?? bar.height
	const geometry = resolveScreenGeometry(di, dev, wb, portraitStatusBarHeight)

	const info = {
		pixelRatio,
		screenWidth: geometry.screenWidth,
		screenHeight: geometry.screenHeight,
		windowWidth, windowHeight,
		statusBarHeight: geometry.statusBarHeight,
		safeArea: geometry.safeArea,
	}
	onSuccess?.(info)
	onComplete?.()
	return info
}

export function getSystemSetting(this: MiniAppContext, { success, complete }: { success?: unknown; complete?: unknown } = {}) {
	const { onSuccess, onComplete } = bindCallbacks(this, { success, complete })
	const { windowWidth, windowHeight } = readWindowMetrics(this)

	const info = {
		bluetoothEnabled: false,
		locationEnabled: true,
		wifiEnabled: true,
		// Same rule as getSystemInfoSync's: what the page shows, not how the simulated device is rotated (see resolveScreenGeometry).
		deviceOrientation: normalizeDeviceOrientation({ windowWidth, windowHeight }),
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

/**
 * The one place this path resolves the screen-geometry family — orientation, screen dimensions, status bar height and safeArea — so they can never describe two different orientations at once.
 *
 * Everything follows the orientation the page is ACTUALLY showing, which the live viewport rect states directly: DeviceShell sizes the phone shell from the top page's effective orientation (device-shell/orientation-controller.ts), so a page pinned to portrait stays portrait on a rotated device.
 * The simulated device's own rotation (`dev.deviceOrientation`, the toolbar control) is deliberately NOT consulted here — it would hand such a page landscape geometry.
 *
 * safeArea follows that orientation too, the same coordinate system the native-host path uses (shared/page-resize-host-env.ts → service-host/sync-impls/system-info.ts): in landscape the notch leaves the top edge for both sides and the home indicator gets thinner.
 * That is what WeChat itself does — its base library re-asks native for a fresh `safeArea` whenever `deviceOrientation` changes instead of transforming the portrait one, and `getSystemInfoSync` passes the current native value straight through.
 * Keeping portrait insets next to landscape dimensions would produce a rect that matches neither.
 *
 * `di` (window.__deviceInfo) keeps its existing override priority over `dev` (SimulatorMiniApp.getDeviceMetrics()); both state the PORTRAIT baseline, so they are re-oriented here. `wb` is the last resort when no device model is known at all, and it is already in the current orientation — it is folded back to a portrait baseline first so the single re-orientation below cannot swap an already-swapped rect.
 */
function resolveScreenGeometry(
	di: Record<string, unknown>,
	dev: DeviceMetrics | undefined,
	wb: { width: number; height: number },
	portraitStatusBarHeight: number,
) {
	const orientation = normalizeDeviceOrientation({ windowWidth: wb.width, windowHeight: wb.height })
	const landscape = orientation === 'landscape'
	const baselineWidth = (di['screenWidth'] as number | undefined) ?? dev?.screenWidth
		?? (landscape ? wb.height : wb.width)
	const baselineHeight = (di['screenHeight'] as number | undefined) ?? dev?.screenHeight
		?? (landscape ? wb.width : wb.height)
	const baselineInsets = (di['safeAreaInsets'] as DeviceMetrics['safeAreaInsets'] | undefined)
		?? dev?.safeAreaInsets
		?? { top: portraitStatusBarHeight, right: 0, bottom: 0, left: 0 }
	const metrics = orientedDeviceMetrics(
		{ screenWidth: baselineWidth, screenHeight: baselineHeight, statusBarHeight: portraitStatusBarHeight },
		orientation,
	)
	const insets = orientedSafeAreaInsets(
		{
			statusBarHeight: portraitStatusBarHeight,
			// Without a selected device only __deviceInfo speaks, and it has no notch field: a bottom inset in portrait is a home indicator, and only screens with one have a cutout to move to the sides.
			hasNotch: dev?.hasNotch ?? baselineInsets.bottom > 0,
			safeAreaInsets: baselineInsets,
		},
		orientation,
	)
	return {
		orientation,
		screenWidth: metrics.screenWidth,
		screenHeight: metrics.screenHeight,
		statusBarHeight: metrics.statusBarHeight,
		safeArea: {
			left: insets.left,
			top: insets.top,
			right: metrics.screenWidth - insets.right,
			bottom: metrics.screenHeight - insets.bottom,
			width: metrics.screenWidth - insets.left - insets.right,
			height: metrics.screenHeight - insets.top - insets.bottom,
		},
	}
}

function buildSystemInfo(miniApp: MiniAppContext) {
	const { wb, di, dev, pixelRatio, windowWidth, windowHeight } = readWindowMetrics(miniApp)
	const portraitStatusBarHeight = (di['statusBarHeight'] as number | undefined) ?? dev?.statusBarHeight ?? 0
	const geometry = resolveScreenGeometry(di, dev, wb, portraitStatusBarHeight)

	return {
		brand: di['brand'] || 'devtools',
		model: di['model'] || 'devtools',
		pixelRatio,
		screenWidth: geometry.screenWidth,
		screenHeight: geometry.screenHeight,
		windowWidth, windowHeight,
		statusBarHeight: geometry.statusBarHeight,
		language: 'zh_CN',
		version: '8.0.5',
		system: di['system'] || 'iOS 16.0',
		platform: di['platform'] || 'ios',
		fontSizeSetting: 16,
		SDKVersion: '3.0.0',
		deviceOrientation: geometry.orientation,
		safeArea: geometry.safeArea,
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
	// Filesystem: the service thread invokes the dotted FileSystemManager.*
	// wire names (see simulator-api-fsm.ts).
	...fileSystemManagerApis,
}
