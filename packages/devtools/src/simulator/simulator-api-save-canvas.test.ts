import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_CANVAS_BASE64_CHARS, MAX_CANVAS_IMAGE_BYTES, saveCanvasTempFile } from './simulator-api-media'
import { revokeAllTempFilePaths, setTempFileSink } from './temp-files'
import type { MiniAppContext } from './types'

function context(): MiniAppContext {
	return {
		appId: 'canvas-test',
		createCallbackFunction: (fn: unknown) => typeof fn === 'function' ? fn as (...args: unknown[]) => void : undefined,
	}
}

const PNG_SIGNATURE_BYTES = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
const JPG_SIGNATURE_BYTES = [0xFF, 0xD8, 0xFF]

/** Base64 of real PNG-signature bytes — a decoded payload the type check accepts as a PNG. */
function pngBase64(): string {
	return Buffer.from(Uint8Array.from([...PNG_SIGNATURE_BYTES, 1, 2, 3, 4])).toString('base64')
}

/** Base64 of real JPEG-signature bytes — a decoded payload the type check accepts as a JPEG. */
function jpgBase64(): string {
	return Buffer.from(Uint8Array.from([...JPG_SIGNATURE_BYTES, 1, 2, 3, 4])).toString('base64')
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
			dataURL: pngBase64(),
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

	it('rejects an appId the native containers would refuse, and never writes a temp file for it', async () => {
		const write = vi.fn()
		const writeAndWait = vi.fn(() => Promise.resolve())
		setTempFileSink({ write, writeAndWait, revoke: vi.fn(), revokeAll: vi.fn() })
		const fail = vi.fn()
		const complete = vi.fn()

		await saveCanvasTempFile.call({ ...context(), appId: '..' }, {
			dataURL: pngBase64(),
			fileType: 'png',
			fail,
			complete,
		})

		const result = { errMsg: 'canvasToTempFilePath:fail invalid appId' }
		expect(fail).toHaveBeenCalledWith(result)
		expect(complete).toHaveBeenCalledWith(result)
		expect(write).not.toHaveBeenCalled()
		expect(writeAndWait).not.toHaveBeenCalled()
	})

	it('reports invalid appId ahead of invalid dataURL when both are wrong', async () => {
		const fail = vi.fn()
		const complete = vi.fn()

		await saveCanvasTempFile.call({ ...context(), appId: 'a/b' }, {
			dataURL: 'data:image/gif;base64,AAAA',
			fileType: 'png',
			fail,
			complete,
		})

		const result = { errMsg: 'canvasToTempFilePath:fail invalid appId' }
		expect(fail).toHaveBeenCalledWith(result)
		expect(complete).toHaveBeenCalledWith(result)
	})

	it('reports invalid file type ahead of invalid appId when both are wrong', async () => {
		const fail = vi.fn()
		const complete = vi.fn()

		await saveCanvasTempFile.call({ ...context(), appId: '..' }, {
			dataURL: btoa('bytes'),
			fileType: 'jpeg',
			fail,
			complete,
		})

		const result = { errMsg: 'canvasToTempFilePath:fail invalid file type' }
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
			dataURL: `data:image/jpeg;base64,${jpgBase64()}`,
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

	it('rejects decoded bytes that are valid base64 but not a real PNG as invalid image data', async () => {
		const success = vi.fn()
		const fail = vi.fn()
		const complete = vi.fn()

		await saveCanvasTempFile.call(context(), {
			dataURL: btoa('png bytes'),
			fileType: 'png',
			success,
			fail,
			complete,
		})

		const result = { errMsg: 'canvasToTempFilePath:fail invalid image data' }
		expect(fail).toHaveBeenCalledWith(result)
		expect(success).not.toHaveBeenCalled()
		expect(complete).toHaveBeenCalledWith(result)
	})

	it('rejects the same non-image bytes for fileType jpg too — the signature check is by content, not the declared type', async () => {
		const success = vi.fn()
		const fail = vi.fn()
		const complete = vi.fn()

		await saveCanvasTempFile.call(context(), {
			dataURL: btoa('png bytes'),
			fileType: 'jpg',
			success,
			fail,
			complete,
		})

		const result = { errMsg: 'canvasToTempFilePath:fail invalid image data' }
		expect(fail).toHaveBeenCalledWith(result)
		expect(success).not.toHaveBeenCalled()
		expect(complete).toHaveBeenCalledWith(result)
	})

	// The base64 length ceiling has slack (base64 runs ~1/3 longer than the bytes it
	// carries), so a payload can sit under MAX_CANVAS_BASE64_CHARS and still decode to
	// more than MAX_CANVAS_IMAGE_BYTES. This is the gap the byte-length check closes.
	it('rejects a decoded payload over the byte ceiling even though its base64 form is still under MAX_CANVAS_BASE64_CHARS', async () => {
		const bytes = new Uint8Array(MAX_CANVAS_IMAGE_BYTES + 1)
		bytes.set(PNG_SIGNATURE_BYTES)
		const base64Data = Buffer.from(bytes).toString('base64')
		expect(base64Data.length).toBeLessThanOrEqual(MAX_CANVAS_BASE64_CHARS)

		const fail = vi.fn()
		const complete = vi.fn()

		await saveCanvasTempFile.call(context(), {
			dataURL: `data:image/png;base64,${base64Data}`,
			fileType: 'png',
			fail,
			complete,
		})

		const result = { errMsg: 'canvasToTempFilePath:fail data too large' }
		expect(fail).toHaveBeenCalledWith(result)
		expect(complete).toHaveBeenCalledWith(result)
	}, 20000)

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
			dataURL: pngBase64(),
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
