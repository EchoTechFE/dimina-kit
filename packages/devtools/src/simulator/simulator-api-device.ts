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
