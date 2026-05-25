/**
 * DevTools API stubs for media-related wx.xxx APIs
 * (image / video / audio).
 *
 * Each exported function is bound with `this` = MiniApp instance
 * (via AppManager.registerApi → MiniApp.invokeApi).
 */

import type { MiniAppContext } from './types'
import { bindDomEvents, type EventBridgeDisposer } from './event-bridge'
import { bindCallbacks } from './simulator-api-helpers'
import { createTempFilePath } from './temp-files'

// ─── Media: Image ────────────────────────────────────────────────────────────

export function chooseImage(
	this: MiniAppContext,
	{ count = 9, sourceType, camera, success, fail, complete }: {
		count?: number
		sizeType?: unknown
		sourceType?: unknown
		camera?: unknown
		success?: unknown
		fail?: unknown
		complete?: unknown
	},
) {
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	const normalizedCount = normalizeChooseMediaCount(count)
	const normalizedSourceType = normalizeStringArray(sourceType, ['album', 'camera'])

	const input = document.createElement('input')
	input.type = 'file'
	input.accept = 'image/*'
	input.multiple = normalizedCount > 1
	if (normalizedSourceType.length === 1 && normalizedSourceType[0] === 'camera') {
		input.setAttribute('capture', camera === 'front' ? 'user' : 'environment')
	}
	input.style.display = 'none'
	document.body.appendChild(input)

	input.addEventListener('change', () => {
		const files = Array.from(input.files || []).slice(0, normalizedCount)
		if (files.length === 0) {
			onFail?.({ errMsg: 'chooseImage:fail cancel' })
			onComplete?.()
			input.remove()
			return
		}
		const tempFilePaths = files.map(f => createTempFilePath(f))
		const tempFiles = files.map((f, i) => ({ path: tempFilePaths[i], size: f.size }))
		onSuccess?.({ tempFilePaths, tempFiles, errMsg: 'chooseImage:ok' })
		onComplete?.()
		input.remove()
	})

	input.click()
}

export function previewImage(
	this: MiniAppContext,
	{ urls, current, success, complete }: { urls?: string[]; current?: string; success?: unknown; complete?: unknown },
) {
	const { onSuccess, onComplete } = bindCallbacks(this, { success, complete })

	if (!urls || urls.length === 0) {
		onComplete?.()
		return
	}

	// Simple overlay preview
	const overlay = document.createElement('div')
	overlay.style.cssText =
		'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;cursor:pointer;'
	const img = document.createElement('img')
	img.src = current || urls[0] || ''
	img.style.cssText = 'max-width:90%;max-height:90%;object-fit:contain;'
	overlay.appendChild(img)
	overlay.addEventListener('click', () => overlay.remove())
	document.body.appendChild(overlay)

	onSuccess?.({ errMsg: 'previewImage:ok' })
	onComplete?.()
}

export function compressImage(
	this: MiniAppContext,
	{ src, quality = 80, success, fail, complete }: {
		src: string
		quality?: number
		success?: unknown
		fail?: unknown
		complete?: unknown
	},
) {
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })

	const img = new Image()
	img.crossOrigin = 'anonymous'
	img.onload = () => {
		try {
			const canvas = document.createElement('canvas')
			canvas.width = img.naturalWidth
			canvas.height = img.naturalHeight
			const ctx = canvas.getContext('2d')!
			ctx.drawImage(img, 0, 0)
			canvas.toBlob(
				(blob) => {
					if (blob) {
						const tempFilePath = createTempFilePath(blob)
						onSuccess?.({ tempFilePath, errMsg: 'compressImage:ok' })
					} else {
						onFail?.({ errMsg: 'compressImage:fail compression error' })
					}
					onComplete?.()
				},
				'image/jpeg',
				quality / 100,
			)
		} catch (error) {
			onFail?.({ errMsg: `compressImage:fail ${(error as Error).message}` })
			onComplete?.()
		}
	}
	img.onerror = () => {
		onFail?.({ errMsg: 'compressImage:fail image load error' })
		onComplete?.()
	}
	img.src = src
}

export function saveImageToPhotosAlbum(
	this: MiniAppContext,
	{ filePath, success, fail, complete }: { filePath: string; success?: unknown; fail?: unknown; complete?: unknown },
) {
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })

	try {
		const a = document.createElement('a')
		a.href = filePath
		a.download = 'image'
		a.click()
		onSuccess?.({ errMsg: 'saveImageToPhotosAlbum:ok' })
	} catch (error) {
		onFail?.({ errMsg: `saveImageToPhotosAlbum:fail ${(error as Error).message}` })
	}
	onComplete?.()
}

export function getImageInfo(
	this: MiniAppContext,
	{ src, success, fail, complete }: { src: string; success?: unknown; fail?: unknown; complete?: unknown },
) {
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })

	const img = new Image()
	img.crossOrigin = 'anonymous'
	img.onload = () => {
		onSuccess?.({
			width: img.naturalWidth,
			height: img.naturalHeight,
			path: src,
			orientation: 'up',
			type: 'unknown',
			errMsg: 'getImageInfo:ok',
		})
		onComplete?.()
	}
	img.onerror = () => {
		onFail?.({ errMsg: 'getImageInfo:fail image load error' })
		onComplete?.()
	}
	img.src = src
}

// ─── Media: Video ────────────────────────────────────────────────────────────

type MediaFileType = 'image' | 'video'
type ChooseMediaCamera = 'back' | 'front'

const VIDEO_METADATA_TIMEOUT_MS = 5000
const VIDEO_THUMBNAIL_TIMEOUT_MS = 500

interface ChooseMediaTempFile {
	tempFilePath: string
	size: number
	duration: number
	height: number
	width: number
	thumbTempFilePath: string
	fileType: MediaFileType
	originalFileObj: File
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string')
		: fallback
}

function normalizeChooseMediaCount(value: unknown): number {
	const n = Number(value)
	if (!Number.isFinite(n)) return 9
	return Math.max(1, Math.min(20, Math.floor(n)))
}

function getChooseMediaAccept(mediaType: string[]): string {
	const wantsMix = mediaType.includes('mix')
	const wantsImage = wantsMix || mediaType.includes('image')
	const wantsVideo = wantsMix || mediaType.includes('video')
	if (wantsImage && wantsVideo) return 'image/*,video/*'
	return wantsVideo ? 'video/*' : 'image/*'
}

function getChooseMediaResultType(files: ChooseMediaTempFile[]): 'image' | 'video' | 'mix' {
	const types = new Set(files.map(file => file.fileType))
	if (types.size > 1) return 'mix'
	return files[0]?.fileType ?? 'image'
}

function readImageMetadata(src: string): Promise<{ width: number; height: number }> {
	return new Promise((resolve) => {
		const img = new Image()
		img.onload = () => resolve({ width: img.naturalWidth || 0, height: img.naturalHeight || 0 })
		img.onerror = () => resolve({ width: 0, height: 0 })
		img.src = src
	})
}

function readVideoMetadata(src: string): Promise<{ width: number; height: number; duration: number; thumbTempFilePath: string }> {
	return new Promise((resolve) => {
		const video = document.createElement('video')
		let settled = false
		let seekTimer: ReturnType<typeof setTimeout> | undefined
		const finish = (metadata: { width: number; height: number; duration: number; thumbTempFilePath: string }) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			if (seekTimer) clearTimeout(seekTimer)
			// Detach handlers so any late-firing DOM events (e.g. onseeked from a
			// previously queued currentTime change) cannot reach into the now-
			// resolved promise and allocate fresh blob: URLs.
			video.onloadedmetadata = null
			video.onseeked = null
			video.onerror = null
			video.removeAttribute('src')
			video.load()
			resolve(metadata)
		}
		const drawThumbnail = (width: number, height: number): Promise<string> => {
			return new Promise((resolveThumb) => {
				let resolved = false
				const done = (value: string) => {
					if (resolved) return
					resolved = true
					resolveThumb(value)
				}
				let canvas: HTMLCanvasElement
				try {
					canvas = document.createElement('canvas')
					canvas.width = width || 1
					canvas.height = height || 1
					const ctx = canvas.getContext('2d')
					ctx?.drawImage(video, 0, 0, canvas.width, canvas.height)
				} catch {
					done('')
					return
				}
				const toDataUrlFallback = () => {
					try {
						done(canvas.toDataURL('image/jpeg', 0.8))
					} catch {
						done('')
					}
				}
				const fallbackTimer = setTimeout(toDataUrlFallback, VIDEO_THUMBNAIL_TIMEOUT_MS)
				try {
					canvas.toBlob(
						(blob) => {
							clearTimeout(fallbackTimer)
							// If the outer readVideoMetadata promise already settled
							// (e.g. the seekTimer fired before toBlob's async callback
							// arrived), we MUST NOT call createTempFilePath here — that
							// would allocate a fresh blob: URL and register it in the
							// temp-files Map with no one ever revoking it. Just drop
							// the blob on the floor; the resolved thumbTempFilePath
							// has already been chosen by the timeout path.
							if (settled || resolved) return
							if (blob) {
								done(createTempFilePath(blob))
							} else {
								toDataUrlFallback()
							}
						},
						'image/jpeg',
						0.8,
					)
				} catch {
					clearTimeout(fallbackTimer)
					toDataUrlFallback()
				}
			})
		}
		const timer = setTimeout(() => finish({ width: 0, height: 0, duration: 0, thumbTempFilePath: '' }), VIDEO_METADATA_TIMEOUT_MS)

		video.preload = 'metadata'
		video.muted = true
		video.onloadedmetadata = () => {
			const width = video.videoWidth || 0
			const height = video.videoHeight || 0
			const duration = Number.isFinite(video.duration) ? video.duration : 0
			const metadata = { width, height, duration, thumbTempFilePath: '' }
			if (!width || !height || duration <= 0) {
				finish(metadata)
				return
			}
			video.onseeked = async () => {
				if (seekTimer) {
					clearTimeout(seekTimer)
					seekTimer = undefined
				}
				const thumbTempFilePath = await drawThumbnail(width, height)
				finish({ ...metadata, thumbTempFilePath })
			}
			seekTimer = setTimeout(() => finish(metadata), VIDEO_THUMBNAIL_TIMEOUT_MS)
			try {
				video.currentTime = Math.min(0.1, Math.max(0, duration - 0.01))
			} catch {
				finish(metadata)
			}
		}
		video.onerror = () => finish({ width: 0, height: 0, duration: 0, thumbTempFilePath: '' })
		video.src = src
	})
}

async function buildChooseMediaTempFile(file: File): Promise<ChooseMediaTempFile> {
	const tempFilePath = createTempFilePath(file)
	const fileType: MediaFileType = file.type.startsWith('video') ? 'video' : 'image'

	if (fileType === 'video') {
		const metadata = await readVideoMetadata(tempFilePath)
		return {
			tempFilePath,
			size: file.size,
			duration: metadata.duration,
			height: metadata.height,
			width: metadata.width,
			thumbTempFilePath: metadata.thumbTempFilePath,
			fileType,
			originalFileObj: file,
		}
	}

	const metadata = await readImageMetadata(tempFilePath)
	return {
		tempFilePath,
		size: file.size,
		duration: 0,
		height: metadata.height,
		width: metadata.width,
		thumbTempFilePath: '',
		fileType,
		originalFileObj: file,
	}
}

export function chooseMedia(
	this: MiniAppContext,
	{ count = 9, mediaType = ['image', 'video'], sourceType = ['album', 'camera'], camera = 'back', success, fail, complete }: {
		count?: number
		mediaType?: unknown
		sourceType?: unknown
		maxDuration?: unknown
		sizeType?: unknown
		camera?: ChooseMediaCamera
		success?: unknown
		fail?: unknown
		complete?: unknown
	},
) {
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	const normalizedCount = normalizeChooseMediaCount(count)
	const normalizedMediaType = normalizeStringArray(mediaType, ['image', 'video'])
	const normalizedSourceType = normalizeStringArray(sourceType, ['album', 'camera'])

	const input = document.createElement('input')
	input.type = 'file'
	input.accept = getChooseMediaAccept(normalizedMediaType)
	input.multiple = normalizedCount > 1
	if (normalizedSourceType.length === 1 && normalizedSourceType[0] === 'camera') {
		input.setAttribute('capture', camera === 'front' ? 'user' : 'environment')
	}
	input.style.display = 'none'
	document.body.appendChild(input)

	input.addEventListener('change', async () => {
		const files = Array.from(input.files || []).slice(0, normalizedCount)
		if (files.length === 0) {
			onFail?.({ errMsg: 'chooseMedia:fail cancel' })
			onComplete?.()
			input.remove()
			return
		}
		try {
			const tempFiles = await Promise.all(files.map(buildChooseMediaTempFile))
			onSuccess?.({
				tempFiles,
				type: getChooseMediaResultType(tempFiles),
				failedCount: 0,
				errMsg: 'chooseMedia:ok',
			})
		} catch (error) {
			onFail?.({ errMsg: `chooseMedia:fail ${(error as Error).message}` })
		} finally {
			onComplete?.()
			input.remove()
		}
	})

	input.click()
}

export function chooseVideo(
	this: MiniAppContext,
	{ sourceType, camera, success, fail, complete }: {
		sourceType?: unknown
		compressed?: unknown
		maxDuration?: unknown
		camera?: unknown
		success?: unknown
		fail?: unknown
		complete?: unknown
	},
) {
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })
	const normalizedSourceType = normalizeStringArray(sourceType, ['album', 'camera'])

	const input = document.createElement('input')
	input.type = 'file'
	input.accept = 'video/*'
	if (normalizedSourceType.length === 1 && normalizedSourceType[0] === 'camera') {
		input.setAttribute('capture', camera === 'front' ? 'user' : 'environment')
	}
	input.style.display = 'none'
	document.body.appendChild(input)

	input.addEventListener('change', async () => {
		const files = Array.from(input.files || [])
		if (files.length === 0) {
			onFail?.({ errMsg: 'chooseVideo:fail cancel' })
			onComplete?.()
			input.remove()
			return
		}
		const file = files[0]!
		const tempFilePath = createTempFilePath(file)
		const metadata = await readVideoMetadata(tempFilePath)
		onSuccess?.({
			tempFilePath,
			duration: metadata.duration,
			size: file.size,
			width: metadata.width,
			height: metadata.height,
			errMsg: 'chooseVideo:ok',
		})
		onComplete?.()
		input.remove()
	})

	input.click()
}

// ─── Media: Audio (container-side handlers for service-apis/audio) ──────────
// service-apis/audio/index.js (injected into the service Worker by the dimina
// container bundle) calls invokeAPI('audioCreate', { audioId }), etc. DOM media
// events on the container's HTMLAudioElement are bridged back to the service
// layer via the `audioListen` handler.

/** Payload delivered to the service-side dispatcher on every audio event. */
interface AudioEventPayload {
	event: string
	currentTime: number
	duration: number
	buffered: number
	paused: boolean
}

/** DOM media event name → mini-program audio event name. */
const AUDIO_EVENT_MAP: Record<string, string> = {
	play: 'play',
	pause: 'pause',
	ended: 'ended',
	error: 'error',
	timeupdate: 'timeUpdate',
	waiting: 'waiting',
	seeking: 'seeking',
	seeked: 'seeked',
	canplay: 'canplay',
}

const _newAudioInstances = new Map<number, HTMLAudioElement>()
/** Disposers that unbind the DOM event bridge for a given audio instance. */
const _audioEventDisposers = new Map<number, EventBridgeDisposer>()
/** The service-side dispatcher callback for a given audio instance. */
const _audioFire = new Map<number, (payload: AudioEventPayload) => void>()

/** Snapshot the current playback state of an audio element. */
function audioSnapshot(audio: HTMLAudioElement, event: string): AudioEventPayload {
	return {
		event,
		currentTime: audio.currentTime || 0,
		duration: Number.isFinite(audio.duration) ? audio.duration : 0,
		buffered: audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0,
		paused: audio.paused,
	}
}

export function audioCreate(this: MiniAppContext, { audioId }: { audioId: number }) {
	_newAudioInstances.set(audioId, new Audio())
}

/**
 * Persistent event-bridge registration. The service-side InnerAudioContext
 * calls this once at construction with a `keep: true` callback; the container
 * resolves a `fire` callback and binds the DOM media events of the matching
 * audio element to it.
 *
 * The dimina service `invokeAPI` runs every callback through
 * `callback.store(success, keep, evtId)` and delivers the resulting callback
 * id under the `success` field of `params` — `evtId` itself is consumed by
 * `callback.store` and never reaches the container payload. So the handler
 * resolves `fire` from `success`, exactly like every other media API.
 */
export function audioListen(this: MiniAppContext, { audioId, success }: { audioId: number; success: unknown }) {
	const audio = _newAudioInstances.get(audioId)
	const fire = this.createCallbackFunction(success) as ((payload: AudioEventPayload) => void) | undefined
	if (!audio || !fire) return

	_audioFire.set(audioId, fire)

	// Rebind cleanly if audioListen is somehow called twice for one instance.
	_audioEventDisposers.get(audioId)?.()
	const dispose = bindDomEvents<AudioEventPayload>(
		audio,
		AUDIO_EVENT_MAP,
		fire,
		event => audioSnapshot(audio, event),
	)
	_audioEventDisposers.set(audioId, dispose)
}

export function audioSetProp(
	this: MiniAppContext,
	{ audioId, prop, value, startTime, loop, volume, playbackRate, autoplay }: {
		audioId: number
		prop: string
		value: unknown
		startTime?: number
		loop?: boolean
		volume?: number
		playbackRate?: number
		autoplay?: boolean
	},
) {
	const audio = _newAudioInstances.get(audioId)
	if (!audio) return
	switch (prop) {
		case 'src':
			audio.src = value as string
			if (startTime != null) audio.currentTime = startTime
			if (loop != null) audio.loop = loop
			if (volume != null) audio.volume = Math.max(0, Math.min(1, volume))
			if (playbackRate != null) audio.playbackRate = playbackRate
			if (autoplay) audio.play().catch(() => {})
			break
		case 'startTime': audio.currentTime = Number(value) || 0; break
		case 'autoplay': audio.autoplay = !!value; break
		case 'loop': audio.loop = !!value; break
		case 'volume': audio.volume = Math.max(0, Math.min(1, Number(value) || 0)); break
		case 'playbackRate': audio.playbackRate = Number(value) || 1; break
	}
}

export function audioPlay(this: MiniAppContext, { audioId, src }: { audioId: number; src?: string }) {
	const audio = _newAudioInstances.get(audioId)
	if (!audio) return
	if (src && audio.src !== src) audio.src = src
	audio.play().catch(() => {})
}

export function audioPause(this: MiniAppContext, { audioId }: { audioId: number }) {
	_newAudioInstances.get(audioId)?.pause()
}

export function audioStop(this: MiniAppContext, { audioId }: { audioId: number }) {
	const audio = _newAudioInstances.get(audioId)
	if (!audio) return
	audio.pause()
	audio.currentTime = 0
	// `stop` has no DOM equivalent — synthesise it through the bridge.
	_audioFire.get(audioId)?.(audioSnapshot(audio, 'stop'))
}

export function audioSeek(this: MiniAppContext, { audioId, position }: { audioId: number; position: number }) {
	const audio = _newAudioInstances.get(audioId)
	if (!audio) return
	audio.currentTime = position
}

export function audioDestroy(this: MiniAppContext, { audioId }: { audioId: number }) {
	_audioEventDisposers.get(audioId)?.()
	_audioEventDisposers.delete(audioId)
	_audioFire.delete(audioId)

	const audio = _newAudioInstances.get(audioId)
	if (!audio) return
	audio.pause()
	audio.removeAttribute('src')
	audio.load()
	_newAudioInstances.delete(audioId)
}
