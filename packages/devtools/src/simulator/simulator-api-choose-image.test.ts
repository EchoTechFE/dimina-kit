/**
 * Failing tests for `chooseImage` simulator stub.
 *
 * Targets two bug fixes:
 *  1. `count` must truncate the returned tempFilePaths / tempFiles (current
 *     implementation returns every selected file regardless of count).
 *  2. `sourceType: ['camera']` must set the input's `capture` attribute
 *     (`'environment'` by default, `'user'` when `camera === 'front'`).
 *
 * Style mirrors `simulator-api-choose-media.test.ts` — helpers are duplicated
 * intentionally so the tests are self-contained.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MiniAppContext } from './types'
import { chooseImage } from './simulator-api-media'
import * as tempFilesModule from './temp-files'

const setTempFileSink = (
	tempFilesModule as unknown as {
		setTempFileSink?: (sink: unknown) => void
	}
).setTempFileSink

function makeContext(): MiniAppContext {
	return {
		appId: 'test-app',
		createCallbackFunction: vi.fn((fn: unknown) => (typeof fn === 'function' ? fn : undefined)),
	} as unknown as MiniAppContext
}

function setInputFiles(input: HTMLInputElement, files: File[]) {
	Object.defineProperty(input, 'files', {
		configurable: true,
		value: files,
	})
}

beforeEach(() => {
	document.body.innerHTML = ''
})

afterEach(() => {
	document.body.innerHTML = ''
	if (typeof setTempFileSink === 'function') setTempFileSink(null)
	tempFilesModule.revokeAllTempFilePaths?.()
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

describe('chooseImage', () => {
	// Item 1 in the brief — truncate selected files by `count`.
	it('truncates tempFilePaths / tempFiles to count when more files are selected', async () => {
		const success = vi.fn()
		const complete = vi.fn()

		chooseImage.call(makeContext(), {
			count: 2,
			success,
			complete,
		})

		const input = document.querySelector('input[type="file"]') as HTMLInputElement
		expect(input).not.toBeNull()
		expect(input.accept).toBe('image/*')

		setInputFiles(input, [
			new File(['a'], 'a.png', { type: 'image/png' }),
			new File(['b'], 'b.png', { type: 'image/png' }),
			new File(['c'], 'c.png', { type: 'image/png' }),
			new File(['d'], 'd.png', { type: 'image/png' }),
		])
		input.dispatchEvent(new Event('change'))

		await vi.waitFor(() => expect(success).toHaveBeenCalled())
		const result = success.mock.calls[0][0]
		expect(result.errMsg).toBe('chooseImage:ok')
		expect(result.tempFilePaths).toHaveLength(2)
		expect(result.tempFiles).toHaveLength(2)
		expect(complete).toHaveBeenCalled()
	})

	// Item 2 in the brief — sourceType=['camera'] sets capture; camera direction wins.
	it('sets capture="environment" when sourceType only contains camera (default back)', () => {
		chooseImage.call(makeContext(), {
			count: 1,
			sourceType: ['camera'],
			success: vi.fn(),
		})

		const input = document.querySelector('input[type="file"]') as HTMLInputElement
		expect(input).not.toBeNull()
		expect(input.getAttribute('capture')).toBe('environment')
	})

	it('sets capture="user" when sourceType=["camera"] and camera="front"', () => {
		chooseImage.call(makeContext(), {
			count: 1,
			sourceType: ['camera'],
			// camera is not a documented chooseImage option pre-fix but the new
			// implementation should still honor it because chooseMedia / chooseVideo do.
			camera: 'front',
			success: vi.fn(),
		} as unknown as Parameters<typeof chooseImage>[0])

		const input = document.querySelector('input[type="file"]') as HTMLInputElement
		expect(input).not.toBeNull()
		expect(input.getAttribute('capture')).toBe('user')
	})

	it('does NOT set capture when sourceType includes album', () => {
		chooseImage.call(makeContext(), {
			count: 1,
			sourceType: ['album', 'camera'],
			success: vi.fn(),
		})

		const input = document.querySelector('input[type="file"]') as HTMLInputElement
		expect(input).not.toBeNull()
		expect(input.hasAttribute('capture')).toBe(false)
	})
})
