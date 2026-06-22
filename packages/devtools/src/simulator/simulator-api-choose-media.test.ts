import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MiniAppContext } from './types'
import { chooseMedia } from './simulator-api-media'
import * as tempFilesModule from './temp-files'

const { resolveTempFilePath, revokeAllTempFilePaths } = tempFilesModule

const setTempFileSink = (
	tempFilesModule as unknown as {
		setTempFileSink?: (sink: unknown) => void
	}
).setTempFileSink

const DIFILE_RE = /^difile:\/\/_tmp\//

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
	if (typeof setTempFileSink === 'function') setTempFileSink(null)
	revokeAllTempFilePaths?.()
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
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
			size: 3,
			width: 640,
			height: 480,
			duration: 0,
			fileType: 'image',
		})
		expect(result.tempFiles[0].tempFilePath).toMatch(DIFILE_RE)
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
			duration: 12,
			width: 1280,
			height: 720,
			thumbTempFilePath: 'data:image/jpeg;base64,thumb',
			fileType: 'video',
		})
		expect(result.tempFiles[1].tempFilePath).toMatch(DIFILE_RE)
		expect(result.tempFiles[0].tempFilePath).toMatch(DIFILE_RE)
		expect(result.tempFiles[0].tempFilePath).not.toBe(result.tempFiles[1].tempFilePath)
	})

	// Item 6 in the brief — chooseMedia success result must include failedCount: 0.
	it('returns failedCount: 0 in the success result', async () => {
		const success = vi.fn()

		chooseMedia.call(makeContext(), {
			count: 1,
			mediaType: ['image'],
			success,
		})

		const input = document.querySelector('input[type="file"]') as HTMLInputElement
		setInputFiles(input, [new File(['one'], 'one.png', { type: 'image/png' })])
		input.dispatchEvent(new Event('change'))

		await vi.waitFor(() => expect(success).toHaveBeenCalled())
		const result = success.mock.calls[0][0]
		expect(result).toMatchObject({ errMsg: 'chooseMedia:ok', failedCount: 0 })
	})

	// Item 7 in the brief — video thumbnail must go through createTempFilePath so
	// it is a `blob:` URL registered in the in-memory temp-files Map, NOT a raw
	// `data:` URL. We stub canvas.toBlob to invoke its callback synchronously
	// with a fake Blob, and assert the resulting thumb is in the temp-files
	// map (resolveTempFilePath returns it without going through fetch).
	it('registers the video thumbTempFilePath through createTempFilePath', async () => {
		const thumbBlob = new Blob(['thumb-bytes'], { type: 'image/jpeg' })
		const fetchSpy = vi.fn(() => Promise.reject(new Error('fetch should not be called')))
		vi.stubGlobal('fetch', fetchSpy)

		const createElement = document.createElement.bind(document)
		vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
			const element = createElement(tagName, options)
			if (tagName.toLowerCase() === 'canvas') {
				Object.defineProperty(element, 'getContext', {
					configurable: true,
					value: vi.fn(() => ({ drawImage: vi.fn() })),
				})
				Object.defineProperty(element, 'toBlob', {
					configurable: true,
					value: vi.fn((cb: BlobCallback) => cb(thumbBlob)),
				})
				// Keep toDataURL around in case the implementation still calls it —
				// the assertion below proves the new code path is taken.
				Object.defineProperty(element, 'toDataURL', {
					configurable: true,
					value: vi.fn(() => 'data:image/jpeg;base64,LEGACY'),
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
			count: 1,
			mediaType: ['video'],
			success,
		})

		const input = document.querySelector('input[type="file"]') as HTMLInputElement
		setInputFiles(input, [new File(['vid'], 'clip.mp4', { type: 'video/mp4' })])
		input.dispatchEvent(new Event('change'))

		await vi.waitFor(() => expect(success).toHaveBeenCalled())
		const result = success.mock.calls[0][0]
		const thumb = result.tempFiles[0].thumbTempFilePath
		expect(typeof thumb).toBe('string')
		expect(thumb.startsWith('data:')).toBe(false)
		expect(thumb).toMatch(DIFILE_RE)

		// The thumb URL must already be in the temp-files registry so
		// resolveTempFilePath returns the cached Blob without hitting fetch.
		const resolved = await resolveTempFilePath(thumb)
		expect(resolved).toBe(thumbBlob)
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	// Each tempFile must carry the originating File instance under
	// `originalFileObj` so downstream callers (e.g. uploadFile passing it back
	// through to the network layer) can recover the underlying Blob without
	// having to refetch the blob: URL.
	it('attaches the original File on each tempFile via originalFileObj', async () => {
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
		const imageFile = new File(['img'], 'image.png', { type: 'image/png' })
		const videoFile = new File(['vid'], 'clip.mp4', { type: 'video/mp4' })

		chooseMedia.call(makeContext(), {
			count: 2,
			mediaType: ['mix'],
			success,
		})

		const input = document.querySelector('input[type="file"]') as HTMLInputElement
		setInputFiles(input, [imageFile, videoFile])
		input.dispatchEvent(new Event('change'))

		await vi.waitFor(() => expect(success).toHaveBeenCalled())
		const result = success.mock.calls[0][0]
		expect(result.tempFiles).toHaveLength(2)
		expect(result.tempFiles[0].originalFileObj).toBe(imageFile)
		expect(result.tempFiles[1].originalFileObj).toBe(videoFile)
	})
})
