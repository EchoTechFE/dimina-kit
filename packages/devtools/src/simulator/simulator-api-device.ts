/**
 * DevTools API stubs for device-related wx.xxx APIs
 * (keyboard / phone / contact / vibrate / scan).
 *
 * Each exported function is bound with `this` = MiniApp instance
 * (via AppManager.registerApi → MiniApp.invokeApi).
 */

import type { MiniAppContext } from './types'
import { bindCallbacks, notSupportedApi } from './simulator-api-helpers'

// ─── Device: Keyboard ────────────────────────────────────────────────────────

export function hideKeyboard(this: MiniAppContext, { success, complete }: { success?: unknown; complete?: unknown } = {}) {
	const { onSuccess, onComplete } = bindCallbacks(this, { success, complete })
	// In web, blur the active element to dismiss virtual keyboard
	if (document.activeElement && typeof (document.activeElement as HTMLElement).blur === 'function') {
		;(document.activeElement as HTMLElement).blur()
	}
	onSuccess?.({ errMsg: 'hideKeyboard:ok' })
	onComplete?.()
}

export function adjustPosition(this: MiniAppContext, { success, complete }: { success?: unknown; complete?: unknown } = {}) {
	const { onSuccess, onComplete } = bindCallbacks(this, { success, complete })
	onSuccess?.({ errMsg: 'adjustPosition:ok' })
	onComplete?.()
}

// ─── Device: Phone ───────────────────────────────────────────────────────────

export function makePhoneCall(
	this: MiniAppContext,
	{ phoneNumber, success, fail, complete }: { phoneNumber: string; success?: unknown; fail?: unknown; complete?: unknown },
) {
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })

	try {
		window.open(`tel:${phoneNumber}`)
		onSuccess?.({ errMsg: 'makePhoneCall:ok' })
	} catch (error) {
		onFail?.({ errMsg: `makePhoneCall:fail ${(error as Error).message}` })
	}
	onComplete?.()
}

// ─── Device: Contact (stub) ──────────────────────────────────────────────────

export const chooseContact = notSupportedApi('chooseContact')

export const addPhoneContact = notSupportedApi('addPhoneContact')

// ─── Device: Vibrate (stub) ──────────────────────────────────────────────────

export function vibrateShort(this: MiniAppContext, { success, complete }: { type?: string; success?: unknown; complete?: unknown } = {}) {
	const { onSuccess, onComplete } = bindCallbacks(this, { success, complete })
	// Navigator.vibrate is available in some browsers
	if (navigator.vibrate) navigator.vibrate(15)
	onSuccess?.({ errMsg: 'vibrateShort:ok' })
	onComplete?.()
}

export function vibrateLong(this: MiniAppContext, { success, complete }: { success?: unknown; complete?: unknown } = {}) {
	const { onSuccess, onComplete } = bindCallbacks(this, { success, complete })
	if (navigator.vibrate) navigator.vibrate(400)
	onSuccess?.({ errMsg: 'vibrateLong:ok' })
	onComplete?.()
}

// ─── Device: Scan (stub) ─────────────────────────────────────────────────────

export const scanCode = notSupportedApi('scanCode')

// ─── Device: Clipboard ───────────────────────────────────────────────────────

export function getClipboardData(
	this: MiniAppContext,
	{ success, fail, complete }: { success?: unknown; fail?: unknown; complete?: unknown } = {},
) {
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	return navigator.clipboard.readText().then(
		(data) => {
			onSuccess?.({ data, errMsg: 'getClipboardData:ok' })
			onComplete?.()
		},
		(error: unknown) => {
			onFail?.({ errMsg: `getClipboardData:fail ${(error as Error)?.message ?? error}` })
			onComplete?.()
		},
	)
}

export function setClipboardData(
	this: MiniAppContext,
	{ data, success, fail, complete }: { data?: string; success?: unknown; fail?: unknown; complete?: unknown } = {},
) {
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	// Parity with the native ClipboardApi: `data` is required.
	if (typeof data !== 'string') {
		onFail?.({ errMsg: 'setClipboardData:fail data is required' })
		onComplete?.()
		return Promise.resolve()
	}
	return navigator.clipboard.writeText(data).then(
		() => {
			onSuccess?.({ errMsg: 'setClipboardData:ok' })
			onComplete?.()
		},
		(error: unknown) => {
			onFail?.({ errMsg: `setClipboardData:fail ${(error as Error)?.message ?? error}` })
			onComplete?.()
		},
	)
}

// ─── Device: Network type ────────────────────────────────────────────────────

export type NetworkType = 'wifi' | '2g' | '3g' | '4g' | '5g' | 'none' | 'unknown'

interface NetworkInfo {
	onLine: boolean
	/** NetworkInformation.type (e.g. 'wifi' / 'ethernet' / 'cellular'). */
	type?: string
	/** NetworkInformation.effectiveType (e.g. '4g' / '3g' / '2g' / 'slow-2g'). */
	effectiveType?: string
}

function mapEffectiveType(effectiveType?: string): NetworkType {
	switch (effectiveType) {
		case '4g':
			return '4g'
		case '3g':
			return '3g'
		case '2g':
		case 'slow-2g':
			return '2g'
		default:
			return 'unknown'
	}
}

/**
 * Best-effort map from the browser's NetworkInformation to the WeChat
 * `getNetworkType` vocabulary. The host machine is almost always on wifi or
 * ethernet, so an online connection with no finer signal reports 'wifi'.
 */
export function resolveNetworkType(info: NetworkInfo): NetworkType {
	if (!info.onLine) return 'none'
	if (info.type === 'wifi' || info.type === 'ethernet') return 'wifi'
	if (info.type === 'cellular') return mapEffectiveType(info.effectiveType)
	if (info.effectiveType) return mapEffectiveType(info.effectiveType)
	return 'wifi'
}

export function getNetworkType(
	this: MiniAppContext,
	{ success, complete }: { success?: unknown; complete?: unknown } = {},
) {
	const { onSuccess, onComplete } = bindCallbacks(this, { success, complete })
	const connection = (navigator as Navigator & {
		connection?: { type?: string; effectiveType?: string }
	}).connection
	const networkType = resolveNetworkType({
		onLine: navigator.onLine,
		type: connection?.type,
		effectiveType: connection?.effectiveType,
	})
	onSuccess?.({ networkType, errMsg: 'getNetworkType:ok' })
	onComplete?.()
}
