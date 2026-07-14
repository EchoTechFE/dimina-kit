import { describe, expect, it, vi } from 'vitest'
import type { MiniAppContext } from './types'
import { saveCanvasTempFile } from './simulator-api-media'

/**
 * Build a MiniAppContext that tracks callbacks by their funcId key.
 * `callbackSpies.get('cb-success')` returns the spy for the success callback.
 */
function makeContext() {
	const callbackSpies = new Map<string, ReturnType<typeof vi.fn>>()
	const ctx = {
		appId: 'test-app',
		createCallbackFunction: vi.fn((funcId: unknown) => {
			if (!funcId) return undefined
			const key = String(funcId)
			if (!callbackSpies.has(key)) callbackSpies.set(key, vi.fn())
			return callbackSpies.get(key)!
		}),
	} as unknown as MiniAppContext
	return { ctx, callbackSpies }
}

/** A minimal valid 1x1 PNG as a data URL. */
const VALID_PNG_DATA_URL =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='

describe('saveCanvasTempFile', () => {
	it('returns a difile://_tmp/ temp path for a valid PNG data URL', () => {
		const { ctx, callbackSpies } = makeContext()

		saveCanvasTempFile.call(ctx, {
			dataURL: VALID_PNG_DATA_URL,
			success: 'cb-success',
			fail: 'cb-fail',
			complete: 'cb-complete',
		})

		const successCb = callbackSpies.get('cb-success')!
		expect(successCb).toHaveBeenCalledOnce()
		const result = successCb.mock.calls[0]![0] as Record<string, unknown>
		expect(result.tempFilePath).toMatch(/^difile:\/\/_tmp\//)
		expect(result.errMsg).toBe('canvasToTempFilePath:ok')

		expect(callbackSpies.get('cb-fail')!).not.toHaveBeenCalled()
		expect(callbackSpies.get('cb-complete')!).toHaveBeenCalledOnce()
	})

	it('calls onFail when dataURL is empty', () => {
		const { ctx, callbackSpies } = makeContext()

		saveCanvasTempFile.call(ctx, {
			dataURL: '',
			success: 'cb-success',
			fail: 'cb-fail',
			complete: 'cb-complete',
		})

		expect(callbackSpies.get('cb-success')!).not.toHaveBeenCalled()
		const failCb = callbackSpies.get('cb-fail')!
		expect(failCb).toHaveBeenCalledOnce()
		expect((failCb.mock.calls[0]![0] as Record<string, unknown>).errMsg).toMatch(/missing dataURL/)
		expect(callbackSpies.get('cb-complete')!).toHaveBeenCalledOnce()
	})

	it('calls onFail for an invalid (non-base64) data URL', () => {
		const { ctx, callbackSpies } = makeContext()

		saveCanvasTempFile.call(ctx, {
			dataURL: 'not-a-data-url',
			success: 'cb-success',
			fail: 'cb-fail',
			complete: 'cb-complete',
		})

		expect(callbackSpies.get('cb-success')!).not.toHaveBeenCalled()
		const failCb = callbackSpies.get('cb-fail')!
		expect(failCb).toHaveBeenCalledOnce()
		expect((failCb.mock.calls[0]![0] as Record<string, unknown>).errMsg).toMatch(/invalid data URL/)
		expect(callbackSpies.get('cb-complete')!).toHaveBeenCalledOnce()
	})

	it('calls onComplete on success even when no fail callback is provided', () => {
		const { ctx, callbackSpies } = makeContext()

		saveCanvasTempFile.call(ctx, {
			dataURL: VALID_PNG_DATA_URL,
			success: 'cb-success',
			complete: 'cb-complete',
		})

		expect(callbackSpies.get('cb-success')!).toHaveBeenCalledOnce()
		expect(callbackSpies.get('cb-complete')!).toHaveBeenCalledOnce()
	})
})
