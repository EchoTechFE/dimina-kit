/**
 * DevTools API stubs for device-related wx.xxx APIs
 * (keyboard / phone / contact / vibrate / scan).
 *
 * Each exported function is bound with `this` = MiniApp instance
 * (via AppManager.registerApi → MiniApp.invokeApi).
 */

import type { MiniAppContext } from './types'

// ─── Device: Keyboard ────────────────────────────────────────────────────────

export function hideKeyboard(this: MiniAppContext, { success, complete }: { success?: unknown; complete?: unknown } = {}) {
	const onSuccess = this.createCallbackFunction(success)
	const onComplete = this.createCallbackFunction(complete)
	// In web, blur the active element to dismiss virtual keyboard
	if (document.activeElement && typeof (document.activeElement as HTMLElement).blur === 'function') {
		;(document.activeElement as HTMLElement).blur()
	}
	onSuccess?.({ errMsg: 'hideKeyboard:ok' })
	onComplete?.()
}

export function adjustPosition(this: MiniAppContext, { success, complete }: { success?: unknown; complete?: unknown } = {}) {
	const onSuccess = this.createCallbackFunction(success)
	const onComplete = this.createCallbackFunction(complete)
	onSuccess?.({ errMsg: 'adjustPosition:ok' })
	onComplete?.()
}

// ─── Device: Phone ───────────────────────────────────────────────────────────

export function makePhoneCall(
	this: MiniAppContext,
	{ phoneNumber, success, fail, complete }: { phoneNumber: string; success?: unknown; fail?: unknown; complete?: unknown },
) {
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)

	try {
		window.open(`tel:${phoneNumber}`)
		onSuccess?.({ errMsg: 'makePhoneCall:ok' })
	} catch (error) {
		onFail?.({ errMsg: `makePhoneCall:fail ${(error as Error).message}` })
	}
	onComplete?.()
}

// ─── Device: Contact (stub) ──────────────────────────────────────────────────

export function chooseContact(this: MiniAppContext, { fail, complete }: { success?: unknown; fail?: unknown; complete?: unknown }) {
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)
	onFail?.({ errMsg: 'chooseContact:fail not supported in simulator' })
	onComplete?.()
}

export function addPhoneContact(this: MiniAppContext, { fail, complete }: { success?: unknown; fail?: unknown; complete?: unknown }) {
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)
	onFail?.({ errMsg: 'addPhoneContact:fail not supported in simulator' })
	onComplete?.()
}

// ─── Device: Vibrate (stub) ──────────────────────────────────────────────────

export function vibrateShort(this: MiniAppContext, { success, complete }: { type?: string; success?: unknown; complete?: unknown } = {}) {
	const onSuccess = this.createCallbackFunction(success)
	const onComplete = this.createCallbackFunction(complete)
	// Navigator.vibrate is available in some browsers
	if (navigator.vibrate) navigator.vibrate(15)
	onSuccess?.({ errMsg: 'vibrateShort:ok' })
	onComplete?.()
}

export function vibrateLong(this: MiniAppContext, { success, complete }: { success?: unknown; complete?: unknown } = {}) {
	const onSuccess = this.createCallbackFunction(success)
	const onComplete = this.createCallbackFunction(complete)
	if (navigator.vibrate) navigator.vibrate(400)
	onSuccess?.({ errMsg: 'vibrateLong:ok' })
	onComplete?.()
}

// ─── Device: Scan (stub) ─────────────────────────────────────────────────────

export function scanCode(
	this: MiniAppContext,
	{ fail, complete }: { onlyFromCamera?: boolean; scanType?: unknown; success?: unknown; fail?: unknown; complete?: unknown } = {},
) {
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)
	onFail?.({ errMsg: 'scanCode:fail not supported in simulator' })
	onComplete?.()
}
