/**
 * DevTools API stubs for media-related wx.xxx APIs
 * (image / video / audio).
 *
 * Each exported function is bound with `this` = MiniApp instance
 * (via AppManager.registerApi → MiniApp.invokeApi).
 */

import type { MiniAppContext } from './types'
import { bindDomEvents, type EventBridgeDisposer } from './event-bridge'

// ─── Media: Image ────────────────────────────────────────────────────────────

export function chooseImage(
	this: MiniAppContext,
	{ count = 9, success, fail, complete }: {
		count?: number
		sizeType?: unknown
		sourceType?: unknown
		success?: unknown
		fail?: unknown
		complete?: unknown
	},
) {
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)

	const input = document.createElement('input')
	input.type = 'file'
	input.accept = 'image/*'
	input.multiple = count > 1
	input.style.display = 'none'
	document.body.appendChild(input)

	input.addEventListener('change', () => {
		const files = Array.from(input.files || [])
		if (files.length === 0) {
			onFail?.({ errMsg: 'chooseImage:fail cancel' })
			onComplete?.()
			input.remove()
			return
		}
		const tempFilePaths = files.map(f => URL.createObjectURL(f))
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
	const onSuccess = this.createCallbackFunction(success)
	const onComplete = this.createCallbackFunction(complete)

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
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)

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
						const tempFilePath = URL.createObjectURL(blob)
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
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)

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
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)

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

export function chooseMedia(
	this: MiniAppContext,
	{ count = 9, mediaType = ['image', 'video'], success, fail, complete }: {
		count?: number
		mediaType?: string[]
		sourceType?: unknown
		maxDuration?: unknown
		sizeType?: unknown
		camera?: unknown
		success?: unknown
		fail?: unknown
		complete?: unknown
	},
) {
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)

	const accept = mediaType.includes('video') && mediaType.includes('image')
		? 'image/*,video/*'
		: mediaType.includes('video') ? 'video/*' : 'image/*'

	const input = document.createElement('input')
	input.type = 'file'
	input.accept = accept
	input.multiple = count > 1
	input.style.display = 'none'
	document.body.appendChild(input)

	input.addEventListener('change', () => {
		const files = Array.from(input.files || [])
		if (files.length === 0) {
			onFail?.({ errMsg: 'chooseMedia:fail cancel' })
			onComplete?.()
			input.remove()
			return
		}
		const tempFiles = files.map(f => ({
			tempFilePath: URL.createObjectURL(f),
			size: f.size,
			fileType: f.type.startsWith('video') ? 'video' : 'image',
		}))
		onSuccess?.({ tempFiles, type: tempFiles[0]?.fileType || 'image', errMsg: 'chooseMedia:ok' })
		onComplete?.()
		input.remove()
	})

	input.click()
}

export function chooseVideo(
	this: MiniAppContext,
	{ success, fail, complete }: {
		sourceType?: unknown
		compressed?: unknown
		maxDuration?: unknown
		camera?: unknown
		success?: unknown
		fail?: unknown
		complete?: unknown
	},
) {
	const onSuccess = this.createCallbackFunction(success)
	const onFail = this.createCallbackFunction(fail)
	const onComplete = this.createCallbackFunction(complete)

	const input = document.createElement('input')
	input.type = 'file'
	input.accept = 'video/*'
	input.style.display = 'none'
	document.body.appendChild(input)

	input.addEventListener('change', () => {
		const files = Array.from(input.files || [])
		if (files.length === 0) {
			onFail?.({ errMsg: 'chooseVideo:fail cancel' })
			onComplete?.()
			input.remove()
			return
		}
		const file = files[0]!
		const tempFilePath = URL.createObjectURL(file)
		onSuccess?.({
			tempFilePath,
			duration: 0,
			size: file.size,
			width: 0,
			height: 0,
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
