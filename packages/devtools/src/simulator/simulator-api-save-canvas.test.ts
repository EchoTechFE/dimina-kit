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

	describe('in-flight export backpressure', () => {
		it('rejects a third concurrent export while two are still pending, per appId', async () => {
			vi.spyOn(console, 'warn').mockImplementation(() => {})
			const resolvers: Array<() => void> = []
			const writeAndWait = vi.fn(() => new Promise<void>((resolve) => { resolvers.push(resolve) }))
			setTempFileSink({ write: vi.fn(), writeAndWait, revoke: vi.fn(), revokeAll: vi.fn() })
			const app = { ...context(), appId: 'canvas-backpressure-reject' }

			// Both calls run synchronously up to their first await (createTempFilePathAsync),
			// so the slot reservation for each has already happened by the time this line
			// returns — no need to yield a tick before sending the third.
			const first = saveCanvasTempFile.call(app, { dataURL: pngBase64(), fileType: 'png', success: vi.fn(), complete: vi.fn() })
			const second = saveCanvasTempFile.call(app, { dataURL: pngBase64(), fileType: 'png', success: vi.fn(), complete: vi.fn() })

			const fail = vi.fn()
			const complete = vi.fn()
			await saveCanvasTempFile.call(app, { dataURL: pngBase64(), fileType: 'png', fail, complete })

			const result = { errMsg: 'canvasToTempFilePath:fail too many pending exports' }
			expect(fail).toHaveBeenCalledWith(result)
			expect(complete).toHaveBeenCalledWith(result)
			expect(writeAndWait).toHaveBeenCalledTimes(2)

			// Drain the two held exports so their slots don't leak into a later test.
			resolvers.forEach(resolve => resolve())
			await Promise.all([first, second])
		})

		it('frees a slot once a pending export settles, letting the next one through', async () => {
			vi.spyOn(console, 'warn').mockImplementation(() => {})
			const resolvers: Array<() => void> = []
			// Only the first two exports (the ones that fill the budget) need to stay
			// pending on demand — the third one, tested below, must resolve on its own so
			// its success proves the freed slot rather than getting stuck itself.
			const writeAndWait = vi.fn()
				.mockImplementationOnce(() => new Promise<void>((resolve) => { resolvers.push(resolve) }))
				.mockImplementationOnce(() => new Promise<void>((resolve) => { resolvers.push(resolve) }))
				.mockImplementation(() => Promise.resolve())
			setTempFileSink({ write: vi.fn(), writeAndWait, revoke: vi.fn(), revokeAll: vi.fn() })
			const app = { ...context(), appId: 'canvas-backpressure-free' }

			const firstSuccess = vi.fn()
			const first = saveCanvasTempFile.call(app, { dataURL: pngBase64(), fileType: 'png', success: firstSuccess, complete: vi.fn() })
			const second = saveCanvasTempFile.call(app, { dataURL: pngBase64(), fileType: 'png', success: vi.fn(), complete: vi.fn() })

			resolvers[0]?.()
			await first
			expect(firstSuccess).toHaveBeenCalledWith(expect.objectContaining({ errMsg: 'canvasToTempFilePath:ok' }))

			const success = vi.fn()
			const complete = vi.fn()
			await saveCanvasTempFile.call(app, { dataURL: pngBase64(), fileType: 'png', success, complete })

			expect(success).toHaveBeenCalledWith(expect.objectContaining({ errMsg: 'canvasToTempFilePath:ok' }))
			expect(complete).toHaveBeenCalledWith(success.mock.calls[0][0])

			resolvers[1]?.()
			await second
		})

		it('frees a slot on a failed export too, not just a successful one', async () => {
			vi.spyOn(console, 'warn').mockImplementation(() => {})
			const writeAndWait = vi.fn(() => Promise.reject(new Error('store disposed')))
			setTempFileSink({ write: vi.fn(), writeAndWait, revoke: vi.fn(), revokeAll: vi.fn() })
			const app = { ...context(), appId: 'canvas-backpressure-fail-frees' }

			const firstFail = vi.fn()
			await saveCanvasTempFile.call(app, { dataURL: pngBase64(), fileType: 'png', fail: firstFail, complete: vi.fn() })
			expect(firstFail).toHaveBeenCalledWith({ errMsg: 'canvasToTempFilePath:fail write failed' })

			// Two more exports in a row must still find room — the failed export above
			// must have given its slot back, not left it stuck occupied.
			const secondFail = vi.fn()
			await saveCanvasTempFile.call(app, { dataURL: pngBase64(), fileType: 'png', fail: secondFail, complete: vi.fn() })
			expect(secondFail).toHaveBeenCalledWith({ errMsg: 'canvasToTempFilePath:fail write failed' })

			const thirdFail = vi.fn()
			await saveCanvasTempFile.call(app, { dataURL: pngBase64(), fileType: 'png', fail: thirdFail, complete: vi.fn() })
			expect(thirdFail).toHaveBeenCalledWith({ errMsg: 'canvasToTempFilePath:fail write failed' })
		})

		it('tracks in-flight exports per appId, so one app cannot exhaust another app\'s budget', async () => {
			vi.spyOn(console, 'warn').mockImplementation(() => {})
			const resolvers: Array<() => void> = []
			const writeAndWait = vi.fn(() => new Promise<void>((resolve) => { resolvers.push(resolve) }))
			setTempFileSink({ write: vi.fn(), writeAndWait, revoke: vi.fn(), revokeAll: vi.fn() })

			const appA = { ...context(), appId: 'canvas-backpressure-app-a' }
			const appB = { ...context(), appId: 'canvas-backpressure-app-b' }

			const a1 = saveCanvasTempFile.call(appA, { dataURL: pngBase64(), fileType: 'png', success: vi.fn(), complete: vi.fn() })
			const a2 = saveCanvasTempFile.call(appA, { dataURL: pngBase64(), fileType: 'png', success: vi.fn(), complete: vi.fn() })

			const fail = vi.fn()
			const complete = vi.fn()
			await saveCanvasTempFile.call(appA, { dataURL: pngBase64(), fileType: 'png', fail, complete })
			expect(fail).toHaveBeenCalledWith({ errMsg: 'canvasToTempFilePath:fail too many pending exports' })

			// appB has spent none of its own budget yet, so its first export still reserves a
			// slot even though appA is pinned at its ceiling.
			const bSuccess = vi.fn()
			const b1 = saveCanvasTempFile.call(appB, { dataURL: pngBase64(), fileType: 'png', success: bSuccess, complete: vi.fn() })
			expect(writeAndWait).toHaveBeenCalledTimes(3)

			resolvers.forEach(resolve => resolve())
			await Promise.all([a1, a2, b1])
			expect(bSuccess).toHaveBeenCalledWith(expect.objectContaining({ errMsg: 'canvasToTempFilePath:ok' }))
		})
	})
})
