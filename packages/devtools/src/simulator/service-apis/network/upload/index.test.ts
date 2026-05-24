import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
	const callbackEntries = new Map<string, (...args: unknown[]) => void>()
	return {
		callbackEntries,
		invokeAPI: vi.fn(),
		store: vi.fn((fn: (...args: unknown[]) => void, _keep?: boolean, evtId?: string) => {
			const id = evtId || `cb_${callbackEntries.size + 1}`
			callbackEntries.set(id, fn)
			return id
		}),
		remove: vi.fn((evtId?: string) => {
			if (evtId) callbackEntries.delete(evtId)
			else callbackEntries.clear()
		}),
	}
})

vi.mock('../../../common', () => ({
	invokeAPI: mocks.invokeAPI,
}))

vi.mock('@dimina/common', () => ({
	callback: {
		store: mocks.store,
		remove: mocks.remove,
	},
}))

import { uploadFile } from './index'

beforeEach(() => {
	mocks.callbackEntries.clear()
	mocks.invokeAPI.mockClear()
	mocks.store.mockClear()
	mocks.remove.mockClear()
})

describe('service uploadFile UploadTask bridge', () => {
	it('returns an UploadTask and forwards progress/header callbacks through callback ids', () => {
		const success = vi.fn()
		const complete = vi.fn()
		const task = uploadFile({
			url: 'https://example.com/upload',
			filePath: 'blob:test',
			name: 'file',
			success,
			complete,
		})

		expect(task).toEqual({
			abort: expect.any(Function),
			onProgressUpdate: expect.any(Function),
			offProgressUpdate: expect.any(Function),
			onHeadersReceived: expect.any(Function),
			offHeadersReceived: expect.any(Function),
		})
		expect(mocks.invokeAPI).toHaveBeenCalledWith('uploadFile', expect.objectContaining({
			uploadId: expect.stringMatching(/^upload_/),
			progress: expect.stringContaining('_progress'),
			headersReceived: expect.stringContaining('_headers'),
			complete: expect.any(Function),
		}))

		const payload = mocks.invokeAPI.mock.calls[0][1]
		const onProgress = vi.fn()
		const onHeaders = vi.fn()
		task.onProgressUpdate(onProgress)
		task.onHeadersReceived(onHeaders)

		mocks.callbackEntries.get(payload.progress)!({ progress: 50 })
		mocks.callbackEntries.get(payload.headersReceived)!({ header: { foo: 'bar' } })

		expect(onProgress).toHaveBeenCalledWith({ progress: 50 })
		expect(onHeaders).toHaveBeenCalledWith({ header: { foo: 'bar' } })

		task.offProgressUpdate()
		mocks.callbackEntries.get(payload.progress)!({ progress: 80 })
		expect(onProgress).toHaveBeenCalledTimes(1)

		payload.complete({ errMsg: 'uploadFile:ok' })
		expect(complete).toHaveBeenCalledWith({ errMsg: 'uploadFile:ok' })
		expect(mocks.remove).toHaveBeenCalledWith(payload.progress)
		expect(mocks.remove).toHaveBeenCalledWith(payload.headersReceived)
	})

	it('clears listener stores when complete fires', () => {
		const task = uploadFile({
			url: 'https://example.com/upload',
			filePath: 'blob:test',
			name: 'file',
		})
		const payload = mocks.invokeAPI.mock.calls[0][1]
		const progressDispatcher = mocks.callbackEntries.get(payload.progress)!
		const headerDispatcher = mocks.callbackEntries.get(payload.headersReceived)!
		const onProgress = vi.fn()
		const onHeaders = vi.fn()
		task.onProgressUpdate(onProgress)
		task.onHeadersReceived(onHeaders)

		payload.complete({ errMsg: 'uploadFile:ok' })
		progressDispatcher({ progress: 99 })
		headerDispatcher({ header: { ignored: '1' } })

		expect(onProgress).not.toHaveBeenCalled()
		expect(onHeaders).not.toHaveBeenCalled()
	})

	it('abort sends uploadFileAbort with the generated upload id until complete fires', () => {
		const task = uploadFile({
			url: 'https://example.com/upload',
			filePath: 'blob:test',
			name: 'file',
		})
		const payload = mocks.invokeAPI.mock.calls[0][1]

		task.abort()
		expect(mocks.invokeAPI).toHaveBeenLastCalledWith('uploadFileAbort', { uploadId: payload.uploadId })

		payload.complete({ errMsg: 'uploadFile:ok' })
		mocks.invokeAPI.mockClear()
		task.abort()
		expect(mocks.invokeAPI).not.toHaveBeenCalled()
	})
})
