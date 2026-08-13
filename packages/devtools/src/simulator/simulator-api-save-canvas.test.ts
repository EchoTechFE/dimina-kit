import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveCanvasTempFile } from './simulator-api-media'
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
})
