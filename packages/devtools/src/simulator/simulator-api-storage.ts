/**
 * DevTools API stubs for wx.xxx storage APIs (sync + async).
 *
 * Each exported function is bound with `this` = MiniApp instance
 * (via AppManager.registerApi → MiniApp.invokeApi).
 */

import type { MiniAppContext } from './types'
import { bindCallbacks } from './simulator-api-helpers'

// ─── shared storage primitives ────────────────────────────────────────────
//
// Every sync/async pair below (set/get/remove/clear/info) shares the same
// underlying localStorage layout: keys are namespaced per appId, values are
// JSON-encoded objects / stringified primitives. These helpers are the
// single authority for that layout so the sync and async variants cannot
// drift apart.

function storageKeyOf(appId: string, key: string): string {
	return `${appId}_${key}`
}

/** Full (still-prefixed) localStorage keys belonging to `appId`. */
function collectAppKeys(appId: string): string[] {
	const prefix = `${appId}_`
	const keys: string[] = []
	for (let i = 0; i < localStorage.length; i++) {
		const k = localStorage.key(i)
		if (k && k.startsWith(prefix)) keys.push(k)
	}
	return keys
}

function writeEntry(appId: string, key: string, data: unknown): void {
	const dataString = typeof data === 'object' ? JSON.stringify(data) : String(data)
	localStorage.setItem(storageKeyOf(appId, key), dataString)
}

/** Reads one entry, JSON-parsing when possible. `undefined` means the key was never set — distinct from a stored empty string. */
function readEntry(appId: string, key: string): { data: unknown } | undefined {
	const raw = localStorage.getItem(storageKeyOf(appId, key))
	if (raw === null) return undefined
	try { return { data: JSON.parse(raw) as unknown } } catch { return { data: raw } }
}

function clearAppKeys(appId: string): void {
	collectAppKeys(appId).forEach(k => localStorage.removeItem(k))
}

function storageInfoOf(appId: string): { keys: string[]; currentSize: number; limitSize: number } {
	const prefix = `${appId}_`
	const keys: string[] = []
	let currentSize = 0
	for (const fullKey of collectAppKeys(appId)) {
		keys.push(fullKey.slice(prefix.length))
		const item = localStorage.getItem(fullKey)
		currentSize += item ? item.length * 2 : 0
	}
	return { keys, currentSize, limitSize: 10 * 1024 * 1024 }
}

// ─── Storage (sync) ──────────────────────────────────────────────────────────

export function setStorageSync(this: MiniAppContext, { key, data }: { key: string; data: unknown }) {
	writeEntry(this.appId, key, data)
}

export function getStorageSync(this: MiniAppContext, { key }: { key: string }) {
	// wx 真机: a missing key returns {data: ''}, never undefined or a fail.
	return readEntry(this.appId, key) ?? { data: '' }
}

export function removeStorageSync(this: MiniAppContext, { key }: { key: string }) {
	localStorage.removeItem(storageKeyOf(this.appId, key))
}

export function clearStorageSync(this: MiniAppContext) {
	clearAppKeys(this.appId)
}

export function getStorageInfoSync(this: MiniAppContext) {
	return storageInfoOf(this.appId)
}

// ─── Storage (async) ────────────────────────────────────────────────────────

export function setStorage(
	this: MiniAppContext,
	{ key, data, success, fail, complete }: { key: string; data: unknown; success?: unknown; fail?: unknown; complete?: unknown },
) {
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	try {
		writeEntry(this.appId, key, data)
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
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	// Unlike getStorageSync, the async variant fails (not {data: ''}) on a
	// missing key — this is the documented wx.getStorage contract.
	const entry = readEntry(this.appId, key)
	if (!entry) {
		onFail?.({ errMsg: 'getStorage:fail data not found' })
	} else {
		onSuccess?.({ data: entry.data, errMsg: 'getStorage:ok' })
	}
	onComplete?.()
}

export function removeStorage(
	this: MiniAppContext,
	{ key, success, fail, complete }: { key: string; success?: unknown; fail?: unknown; complete?: unknown },
) {
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	try {
		localStorage.removeItem(storageKeyOf(this.appId, key))
		onSuccess?.({ errMsg: 'removeStorage:ok' })
	} catch (e) {
		onFail?.({ errMsg: `removeStorage:fail ${(e as Error).message}` })
	}
	onComplete?.()
}

export function clearStorage(this: MiniAppContext, { success, complete }: { success?: unknown; complete?: unknown } = {}) {
	const { onSuccess, onComplete } = bindCallbacks(this, { success, complete })
	clearAppKeys(this.appId)
	onSuccess?.({ errMsg: 'clearStorage:ok' })
	onComplete?.()
}

export function getStorageInfo(this: MiniAppContext, { success, complete }: { success?: unknown; complete?: unknown } = {}) {
	const { onSuccess, onComplete } = bindCallbacks(this, { success, complete })
	const info = storageInfoOf(this.appId)
	onSuccess?.({ ...info, errMsg: 'getStorageInfo:ok' })
	onComplete?.()
}
