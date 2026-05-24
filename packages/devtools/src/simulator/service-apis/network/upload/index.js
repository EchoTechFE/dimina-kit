import { callback } from '@dimina/common'
import { invokeAPI } from '../../../common'

let nextUploadId = 1

function createUploadId() {
	return `upload_${Date.now()}_${nextUploadId++}`
}

function createListenerStore() {
	let listeners = []
	return {
		add(listener) {
			if (typeof listener !== 'function') return
			listeners.push(listener)
		},
		remove(listener) {
			if (typeof listener === 'function') {
				listeners = listeners.filter(item => item !== listener)
			} else {
				listeners = []
			}
		},
		dispatch(payload) {
			for (const listener of listeners.slice()) {
				listener(payload)
			}
		},
	}
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/network/upload/wx.uploadFile.html
 *
 * The actual XHR runs in the container layer. This service-side object mirrors
 * WeChat's UploadTask shape so Taro can attach progress/header/abort methods
 * synchronously while normal success/fail/complete callbacks still travel
 * through dimina's callback-id bridge.
 */
export function uploadFile(opts = {}) {
	const uploadId = createUploadId()
	const progressListeners = createListenerStore()
	const headerListeners = createListenerStore()
	const progressId = callback.store(payload => progressListeners.dispatch(payload), true, `${uploadId}_progress`)
	const headersId = callback.store(payload => headerListeners.dispatch(payload), true, `${uploadId}_headers`)
	const originalComplete = opts.complete
	let finished = false

	const cleanup = (result) => {
		if (finished) return
		finished = true
		callback.remove(progressId)
		callback.remove(headersId)
		progressListeners.remove()
		headerListeners.remove()
		if (typeof originalComplete === 'function') {
			originalComplete(result)
		}
	}

	invokeAPI('uploadFile', {
		...opts,
		uploadId,
		progress: progressId,
		headersReceived: headersId,
		complete: cleanup,
	})

	return {
		abort() {
			if (finished) return
			invokeAPI('uploadFileAbort', { uploadId })
		},
		onProgressUpdate(listener) {
			progressListeners.add(listener)
		},
		offProgressUpdate(listener) {
			progressListeners.remove(listener)
		},
		onHeadersReceived(listener) {
			headerListeners.add(listener)
		},
		offHeadersReceived(listener) {
			headerListeners.remove(listener)
		},
	}
}
