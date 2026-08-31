import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_CANVAS_BASE64_CHARS, saveCanvasTempFile } from './simulator-api-media'
import { revokeAllTempFilePaths, setTempFileSink } from './temp-files'
import type { MiniAppContext } from './types'

function context(): MiniAppContext {
	return {
		appId: 'canvas-test',
		createCallbackFunction: (fn: unknown) => typeof fn === 'function' ? fn as (...args: unknown[]) => void : undefined,
	}
}

afterEach(() => {
	setTempFileSink(null)
	revokeAllTempFilePaths()
	vi.restoreAllMocks()
})

describe('saveCanvasTempFile', () => {
	it('reports success only after the temp bytes are confirmed in the main store', async () => {
		let confirm: (() => void) | undefined
		setTempFileSink({
			write: vi.fn(),
			writeAndWait: vi.fn(() => new Promise<void>((resolve) => {
				confirm = resolve
			})),
			revoke: vi.fn(),
			revokeAll: vi.fn(),
		})
		const success = vi.fn()
		const complete = vi.fn()

		const pending = saveCanvasTempFile.call(context(), {
			dataURL: btoa('png bytes'),
			fileType: 'png',
			success,
			complete,
		})
		await Promise.resolve()
		expect(success).not.toHaveBeenCalled()
		expect(complete).not.toHaveBeenCalled()

		confirm?.()
		await pending
		expect(success).toHaveBeenCalledWith(expect.objectContaining({
			errMsg: 'canvasToTempFilePath:ok',
			tempFilePath: expect.stringMatching(/^difile:\/\/_tmp\//),
		}))
		expect(complete).toHaveBeenCalledWith(success.mock.calls[0][0])
	})

	it('rejects file types outside the official png/jpg whitelist', async () => {
		const fail = vi.fn()
		const complete = vi.fn()

		await saveCanvasTempFile.call(context(), {
			dataURL: btoa('bytes'),
			fileType: 'jpeg',
			fail,
			complete,
		})

		const result = { errMsg: 'canvasToTempFilePath:fail invalid file type' }
		expect(fail).toHaveBeenCalledWith(result)
		expect(complete).toHaveBeenCalledWith(result)
	})

	it('rejects a data: URL whose prefix does not match the allowed image mime types', async () => {
		const fail = vi.fn()
		const complete = vi.fn()

		await saveCanvasTempFile.call(context(), {
			dataURL: `data:image/gif;base64,${btoa('bytes')}`,
			fileType: 'png',
			fail,
			complete,
		})

		const result = { errMsg: 'canvasToTempFilePath:fail invalid dataURL' }
		expect(fail).toHaveBeenCalledWith(result)
		expect(complete).toHaveBeenCalledWith(result)
	})

	it('rejects a data: URL prefix that disagrees with the requested fileType', async () => {
		const fail = vi.fn()
		const complete = vi.fn()

		await saveCanvasTempFile.call(context(), {
			dataURL: `data:image/png;base64,${btoa('bytes')}`,
			fileType: 'jpg',
			fail,
			complete,
		})

		const result = { errMsg: 'canvasToTempFilePath:fail file type mismatch' }
		expect(fail).toHaveBeenCalledWith(result)
		expect(complete).toHaveBeenCalledWith(result)
	})

	it('accepts the official image/jpeg prefix paired with fileType jpg', async () => {
		setTempFileSink({
			write: vi.fn(),
			writeAndWait: vi.fn(() => Promise.resolve()),
			revoke: vi.fn(),
			revokeAll: vi.fn(),
		})
		const success = vi.fn()
		const complete = vi.fn()

		await saveCanvasTempFile.call(context(), {
			dataURL: `data:image/jpeg;base64,${btoa('bytes')}`,
			fileType: 'jpg',
			success,
			complete,
		})

		expect(success).toHaveBeenCalledWith(expect.objectContaining({
			errMsg: 'canvasToTempFilePath:ok',
			tempFilePath: expect.stringMatching(/^difile:\/\/_tmp\//),
		}))
		expect(complete).toHaveBeenCalledWith(success.mock.calls[0][0])
	})

	it('rejects base64 payloads longer than the native MAX_CANVAS_BASE64_CHARS limit', async () => {
		const fail = vi.fn()
		const complete = vi.fn()

		await saveCanvasTempFile.call(context(), {
			dataURL: `data:image/png;base64,${'A'.repeat(MAX_CANVAS_BASE64_CHARS + 4)}`,
			fileType: 'png',
			fail,
			complete,
		})

		const result = { errMsg: 'canvasToTempFilePath:fail data too large' }
		expect(fail).toHaveBeenCalledWith(result)
		expect(complete).toHaveBeenCalledWith(result)
	})

	it('rejects an empty base64 payload as a decode failure', async () => {
		const fail = vi.fn()
		const complete = vi.fn()

		await saveCanvasTempFile.call(context(), {
			dataURL: 'data:image/png;base64,',
			fileType: 'png',
			fail,
			complete,
		})

		const result = { errMsg: 'canvasToTempFilePath:fail base64 decode failed' }
		expect(fail).toHaveBeenCalledWith(result)
		expect(complete).toHaveBeenCalledWith(result)
	})

	it('rejects a base64 payload whose length is not a multiple of four as a decode failure', async () => {
		const fail = vi.fn()
		const complete = vi.fn()

		await saveCanvasTempFile.call(context(), {
			dataURL: 'data:image/png;base64,QUJDRA',
			fileType: 'png',
			fail,
			complete,
		})

		const result = { errMsg: 'canvasToTempFilePath:fail base64 decode failed' }
		expect(fail).toHaveBeenCalledWith(result)
		expect(complete).toHaveBeenCalledWith(result)
	})

	it('rejects a base64 payload containing characters outside the base64 alphabet as a decode failure', async () => {
		const fail = vi.fn()
		const complete = vi.fn()

		await saveCanvasTempFile.call(context(), {
			dataURL: 'data:image/png;base64,QUJD!==',
			fileType: 'png',
			fail,
			complete,
		})

		const result = { errMsg: 'canvasToTempFilePath:fail base64 decode failed' }
		expect(fail).toHaveBeenCalledWith(result)
		expect(complete).toHaveBeenCalledWith(result)
	})

	it('normalizes a store write failure instead of leaking its cause into errMsg', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		setTempFileSink({
			write: vi.fn(),
			writeAndWait: vi.fn(() => Promise.reject(new Error('store disposed'))),
			revoke: vi.fn(),
			revokeAll: vi.fn(),
		})
		const fail = vi.fn()
		const complete = vi.fn()

		await saveCanvasTempFile.call(context(), {
			dataURL: btoa('png bytes'),
			fileType: 'png',
			fail,
			complete,
		})

		const result = { errMsg: 'canvasToTempFilePath:fail write failed' }
		expect(fail).toHaveBeenCalledWith(result)
		expect(complete).toHaveBeenCalledWith(result)
		expect(warn).toHaveBeenCalled()
	})
})
