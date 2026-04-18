/**
 * DevTools API stubs for wx.xxx storage APIs (sync + async).
 *
 * Each exported function is bound with `this` = MiniApp instance
 * (via AppManager.registerApi → MiniApp.invokeApi).
 */

import type { MiniAppContext } from './types'

// ─── Storage (sync) ──────────────────────────────────────────────────────────

export function setStorageSync(this: MiniAppContext, { key, data }: { key: string; data: unknown }) {
	const storageKey = `${this.appId}_${key}`
	const dataString = typeof data === 'object' ? JSON.stringify(data) : String(data)
	localStorage.setItem(storageKey, dataString)
}

export function getStorageSync(this: MiniAppContext, { key }: { key: string }) {
	const storageKey = `${this.appId}_${key}`
	const raw = localStorage.getItem(storageKey)
	if (raw === null) return { data: '' }
	try { return { data: JSON.parse(raw) as unknown } } catch { return { data: raw } }
}

export function removeStorageSync(this: MiniAppContext, { key }: { key: string }) {
	const storageKey = `${this.appId}_${key}`
	localStorage.removeItem(storageKey)
}

export function clearStorageSync(this: MiniAppContext) {
	const prefix = `${this.appId}_`
	const keysToRemove: string[] = []
	for (let i = 0; i < localStorage.length; i++) {
		const k = localStorage.key(i)
		if (k && k.startsWith(prefix)) keysToRemove.push(k)
	}
	keysToRemove.forEach(k => localStorage.removeItem(k))
}

export function getStorageInfoSync(this: MiniAppContext) {
	const prefix = `${this.appId}_`
	const keys: string[] = []
	let currentSize = 0
	for (let i = 0; i < localStorage.length; i++) {
		const fullKey = localStorage.key(i)
		if (fullKey && fullKey.startsWith(prefix)) {
			keys.push(fullKey.substring(prefix.length))
			const item = localStorage.getItem(fullKey)
			currentSize += item ? item.length * 2 : 0
		}
	}
	return { keys, currentSize, limitSize: 10 * 1024 * 1024 }
}

// ─── Storage (async) ────────────────────────────────────────────────────────

export function setStorage(
	this: MiniAppContext,
	{ key, data, success, fail, complete }: { key: string; data: unknown; success?: unknown; fail?: unknown; complete?: unknown },
) {
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)
	try {
		const storageKey = `${this.appId}_${key}`
		const dataString = typeof data === 'object' ? JSON.stringify(data) : String(data)
		localStorage.setItem(storageKey, dataString)
		onSuccess?.({ errMsg: 'setStorage:ok' })
	} catch (e) {
		onFail?.({ errMsg: `setStorage:fail ${(e as Error).message}` })
	}
	onComplete?.()
}

export function getStorage(
	this: MiniAppContext,
	{ key, success, fail, complete }: { key: string; success?: unknown; fail?: unknown; complete?: unknown },
) {
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)
	const storageKey = `${this.appId}_${key}`
	const raw = localStorage.getItem(storageKey)
	if (raw === null) {
		onFail?.({ errMsg: 'getStorage:fail data not found' })
	} else {
		let data: unknown
		try { data = JSON.parse(raw) } catch { data = raw }
		onSuccess?.({ data, errMsg: 'getStorage:ok' })
	}
	onComplete?.()
}

export function removeStorage(
	this: MiniAppContext,
	{ key, success, fail, complete }: { key: string; success?: unknown; fail?: unknown; complete?: unknown },
) {
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)
	try {
		const storageKey = `${this.appId}_${key}`
		localStorage.removeItem(storageKey)
		onSuccess?.({ errMsg: 'removeStorage:ok' })
	} catch (e) {
		onFail?.({ errMsg: `removeStorage:fail ${(e as Error).message}` })
	}
	onComplete?.()
}

export function clearStorage(this: MiniAppContext, { success, complete }: { success?: unknown; complete?: unknown } = {}) {
	const onSuccess = this.createCallbackFunction(success)
	const onComplete = this.createCallbackFunction(complete)
	const prefix = `${this.appId}_`
	const keysToRemove: string[] = []
	for (let i = 0; i < localStorage.length; i++) {
		const k = localStorage.key(i)
		if (k && k.startsWith(prefix)) keysToRemove.push(k)
	}
	keysToRemove.forEach(k => localStorage.removeItem(k))
	onSuccess?.({ errMsg: 'clearStorage:ok' })
	onComplete?.()
}

export function getStorageInfo(this: MiniAppContext, { success, complete }: { success?: unknown; complete?: unknown } = {}) {
	const onSuccess = this.createCallbackFunction(success)
	const onComplete = this.createCallbackFunction(complete)
	const prefix = `${this.appId}_`
	const keys: string[] = []
	let currentSize = 0
	for (let i = 0; i < localStorage.length; i++) {
		const fullKey = localStorage.key(i)
		if (fullKey && fullKey.startsWith(prefix)) {
			keys.push(fullKey.substring(prefix.length))
			const item = localStorage.getItem(fullKey)
			currentSize += item ? item.length * 2 : 0
		}
	}
	onSuccess?.({ keys, currentSize, limitSize: 10 * 1024 * 1024, errMsg: 'getStorageInfo:ok' })
	onComplete?.()
}
