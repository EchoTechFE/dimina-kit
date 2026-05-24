import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MiniAppContext } from './types'
import { chooseMedia } from './simulator-api-media'

const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
let objectUrlId = 0

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
	objectUrlId = 0
	document.body.innerHTML = ''
	Object.defineProperty(URL, 'createObjectURL', {
		configurable: true,
		value: vi.fn(() => `blob:mock-${++objectUrlId}`),
	})
	vi.stubGlobal('Image', class {
		onload: ((event: Event) => void) | null = null
		onerror: ((event: Event) => void) | null = null
		naturalWidth = 640
		naturalHeight = 480

		set src(_value: string) {
			queueMicrotask(() => this.onload?.(new Event('load')))
		}
	})
})

afterEach(() => {
	document.body.innerHTML = ''
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
	if (originalCreateObjectURL) {
		Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL)
	} else {
		delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL
	}
})

describe('chooseMedia', () => {
	it('configures the file picker from media/source options and limits selected files by count', async () => {
		const success = vi.fn()
		const complete = vi.fn()

		chooseMedia.call(makeContext(), {
			count: 1.7,
			mediaType: ['mix'],
			sourceType: ['camera'],
			camera: 'front',
			success,
			complete,
		})

		const input = document.querySelector('input[type="file"]') as HTMLInputElement
		expect(input.accept).toBe('image/*,video/*')
		expect(input.multiple).toBe(false)
		expect(input.getAttribute('capture')).toBe('user')

		setInputFiles(input, [
			new File(['one'], 'one.png', { type: 'image/png' }),
			new File(['two'], 'two.png', { type: 'image/png' }),
		])
		input.dispatchEvent(new Event('change'))

		await vi.waitFor(() => expect(success).toHaveBeenCalled())
		const result = success.mock.calls[0][0]
		expect(result).toMatchObject({ type: 'image', errMsg: 'chooseMedia:ok' })
		expect(result.tempFiles).toHaveLength(1)
		expect(result.tempFiles[0]).toMatchObject({
			tempFilePath: 'blob:mock-1',
			size: 3,
			width: 640,
			height: 480,
			duration: 0,
			fileType: 'image',
		})
		expect(complete).toHaveBeenCalled()
		expect(document.querySelector('input[type="file"]')).toBeNull()
	})

	it('returns type "mix" and video metadata when image and video files are selected together', async () => {
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
		const success = vi.fn()

		chooseMedia.call(makeContext(), {
			count: 2,
			mediaType: ['mix'],
			success,
		})

		const input = document.querySelector('input[type="file"]') as HTMLInputElement
		setInputFiles(input, [
			new File(['img'], 'image.png', { type: 'image/png' }),
			new File(['vid'], 'clip.mp4', { type: 'video/mp4' }),
		])
		input.dispatchEvent(new Event('change'))

		await vi.waitFor(() => expect(success).toHaveBeenCalled())
		const result = success.mock.calls[0][0]
		expect(result).toMatchObject({ type: 'mix', errMsg: 'chooseMedia:ok' })
		expect(result.tempFiles).toHaveLength(2)
		expect(result.tempFiles[1]).toMatchObject({
			tempFilePath: 'blob:mock-2',
			duration: 12,
			width: 1280,
			height: 720,
			thumbTempFilePath: 'data:image/jpeg;base64,thumb',
			fileType: 'video',
		})
	})
})
