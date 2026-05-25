/**
 * Failing tests for `chooseVideo` simulator stub.
 *
 * Targets two bug fixes:
 *  4. The success result must carry real width/height/duration read from the
 *     video element metadata (current impl returns 0/0/0).
 *  5. `sourceType: ['camera']` + `camera` must set the file input's `capture`
 *     attribute (`'environment'` for back / `'user'` for front).
 *
 * Style mirrors `simulator-api-choose-media.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MiniAppContext } from './types'
import { chooseVideo } from './simulator-api-media'
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

/**
 * Patch document.createElement so any `video` element we create resolves
 * `onloadedmetadata` (and `onseeked`) with deterministic 1280x720 / 12s metadata.
 */
function installVideoStub() {
	const createElement = document.createElement.bind(document)
	vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
		const element = createElement(tagName, options)
		if (tagName.toLowerCase() === 'canvas') {
			Object.defineProperty(element, 'getContext', {
				configurable: true,
				value: vi.fn(() => ({ drawImage: vi.fn() })),
			})
			Object.defineProperty(element, 'toDataURL', {
				configurable: true,
				value: vi.fn(() => 'data:image/jpeg;base64,thumb'),
			})
		}
		if (tagName.toLowerCase() === 'video') {
			Object.defineProperty(element, 'videoWidth', { configurable: true, value: 1280 })
			Object.defineProperty(element, 'videoHeight', { configurable: true, value: 720 })
			Object.defineProperty(element, 'duration', { configurable: true, value: 12 })
			Object.defineProperty(element, 'load', { configurable: true, value: vi.fn() })
			Object.defineProperty(element, 'src', {
				configurable: true,
				get: () => '',
				set: () => queueMicrotask(() => (element as HTMLVideoElement).onloadedmetadata?.(new Event('loadedmetadata'))),
			})
			Object.defineProperty(element, 'currentTime', {
				configurable: true,
				get: () => 0.1,
				set: () => queueMicrotask(() => (element as HTMLVideoElement).onseeked?.(new Event('seeked'))),
			})
		}
		return element
	}) as typeof document.createElement)
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

describe('chooseVideo', () => {
	// Item 4 — width/height/duration must come from the actual video metadata.
	it('returns width/height/duration read from the video element metadata', async () => {
		installVideoStub()
		const success = vi.fn()

		chooseVideo.call(makeContext(), { success })

		const input = document.querySelector('input[type="file"]') as HTMLInputElement
		expect(input).not.toBeNull()
		expect(input.accept).toBe('video/*')

		setInputFiles(input, [new File(['vid'], 'clip.mp4', { type: 'video/mp4' })])
		input.dispatchEvent(new Event('change'))

		await vi.waitFor(() => expect(success).toHaveBeenCalled())
		const result = success.mock.calls[0][0]
		expect(result.errMsg).toBe('chooseVideo:ok')
		expect(result).toMatchObject({
			width: 1280,
			height: 720,
			duration: 12,
		})
	})

	// Item 5 — sourceType=['camera'] sets capture; camera direction wins.
	it('sets capture="environment" when sourceType=["camera"] (default back)', () => {
		chooseVideo.call(makeContext(), {
			sourceType: ['camera'],
			success: vi.fn(),
		})

		const input = document.querySelector('input[type="file"]') as HTMLInputElement
		expect(input).not.toBeNull()
		expect(input.getAttribute('capture')).toBe('environment')
	})

	it('sets capture="user" when sourceType=["camera"] and camera="front"', () => {
		chooseVideo.call(makeContext(), {
			sourceType: ['camera'],
			camera: 'front',
			success: vi.fn(),
		})

		const input = document.querySelector('input[type="file"]') as HTMLInputElement
		expect(input).not.toBeNull()
		expect(input.getAttribute('capture')).toBe('user')
	})

	it('does NOT set capture when sourceType includes album', () => {
		chooseVideo.call(makeContext(), {
			sourceType: ['album', 'camera'],
			success: vi.fn(),
		})

		const input = document.querySelector('input[type="file"]') as HTMLInputElement
		expect(input).not.toBeNull()
		expect(input.hasAttribute('capture')).toBe(false)
	})
})
