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
import { readVPathBytesSync } from './simulator-api-fs'
import { createTempFilePath, createTempFilePathAsync, resolveTempFilePath } from './temp-files'

// ─── shared file-picker scaffolding ───────────────────────────────────────
//
// chooseImage / chooseVideo / chooseMedia all drive the browser file picker
// through a hidden `<input type=file>`: create it, wire accept/multiple/
// capture from the caller's options, listen for `change`, and report a
// `${apiName}:fail cancel` when the user closes the dialog without picking
// anything. `createFilePicker` is the single authority for that scaffold;
// each API supplies only its accept string, multiplicity, and the
// (possibly async) processing of the picked files.

type CancelCallbacks = Pick<ReturnType<typeof bindCallbacks>, 'onFail' | 'onComplete'>

interface FilePickerConfig {
	accept: string
	multiple: boolean
	/** `capture` attribute value, or `undefined` to omit it (album source, or no single-camera source requested). */
	capture?: 'user' | 'environment'
}

/** Resolves the `capture` attribute from `sourceType` + `camera`: only set when the caller asked for camera-only capture. */
function captureAttrFor(sourceType: string[], camera: unknown): 'user' | 'environment' | undefined {
	if (sourceType.length !== 1 || sourceType[0] !== 'camera') return undefined
	return camera === 'front' ? 'user' : 'environment'
}

/**
 * Drives a hidden `<input type=file>` through one pick cycle. Reports
 * `${apiName}:fail cancel` + `complete` when the selection is empty;
 * otherwise hands the raw (un-truncated) `FileList` to `onPick`, which owns
 * success/fail/complete and must call `removeInput` once it is done with the
 * picker element.
 */
function createFilePicker(
	apiName: string,
	config: FilePickerConfig,
	cbs: CancelCallbacks,
	onPick: (files: File[], removeInput: () => void) => void | Promise<void>,
): void {
	const input = document.createElement('input')
	input.type = 'file'
	input.accept = config.accept
	input.multiple = config.multiple
	if (config.capture) input.setAttribute('capture', config.capture)
	input.style.display = 'none'
	document.body.appendChild(input)

	const removeInput = () => input.remove()

	input.addEventListener('change', () => {
		const files = Array.from(input.files || [])
		if (files.length === 0) {
			cbs.onFail?.({ errMsg: `${apiName}:fail cancel` })
			cbs.onComplete?.()
			removeInput()
			return
		}
		void onPick(files, removeInput)
	})

	input.click()
}

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
	const cbs = bindCallbacks(this, { success, fail, complete })
	const { onSuccess, onComplete } = cbs
	const normalizedCount = normalizeChooseMediaCount(count)
	const normalizedSourceType = normalizeStringArray(sourceType, ['album', 'camera'])

	createFilePicker(
		'chooseImage',
		{ accept: 'image/*', multiple: normalizedCount > 1, capture: captureAttrFor(normalizedSourceType, camera) },
		cbs,
		(rawFiles, removeInput) => {
			const files = rawFiles.slice(0, normalizedCount)
			const tempFilePaths = files.map(f => createTempFilePath(f))
			const tempFiles = files.map((f, i) => ({ path: tempFilePaths[i], size: f.size }))
			onSuccess?.({ tempFilePaths, tempFiles, errMsg: 'chooseImage:ok' })
			onComplete?.()
			removeInput()
		},
	)
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

// Same ceiling the three native containers enforce on a canvas export (android
// ImageApi.kt, iOS ImageAPI.swift, harmony DMPContainerBridgesModule+Canvas.ets), so
// an export that a device would reject does not quietly succeed in the simulator.
// The base64 form is only a cheap pre-filter: base64 runs a third longer than the
// bytes it carries, so a payload can pass it and still decode past the byte ceiling.
export const MAX_CANVAS_IMAGE_BYTES = 32 * 1024 * 1024
export const MAX_CANVAS_BASE64_CHARS = Math.floor(MAX_CANVAS_IMAGE_BYTES * 4 / 3) + 8

// A file named .png that is not a PNG is useless to whoever reads the temp file back,
// so the native containers check the signature before writing and report the payload
// as invalid rather than minting a broken file.
const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
function matchesImageType(bytes: Uint8Array, fileType: 'png' | 'jpg'): boolean {
	if (fileType === 'png') {
		return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)
	}
	return bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF
}

// The render layer strips the data-URL prefix before it invokes the container, so a
// prefix reaching here comes from a hand-built payload; the native containers accept
// it only for the image types canvas can produce.
const CANVAS_DATA_URL_PREFIX = /^data:image\/(png|jpeg|jpg);base64,/
const STRICT_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

// The three containers put the appId straight into a sandbox path, so they reject one
// that could climb out of it. The simulator names temp files by uuid and never builds a
// path from the appId, but a mini program branches on errMsg, so an appId the containers
// refuse must be refused here too rather than exporting fine only in the simulator.
const SAFE_CANVAS_APP_ID = /^[A-Za-z0-9._-]+$/
function isValidCanvasAppId(appId: unknown): boolean {
	return typeof appId === 'string' && SAFE_CANVAS_APP_ID.test(appId) && appId !== '.' && appId !== '..'
}

// Rejects a payload whose declared shape can't have come out of a canvas, and hands
// back the base64 body once it can.
function readCanvasDataURL(
	dataURL: string,
	fileType: string,
	appId: unknown,
): { reason: string } | { base64Data: string; fileType: 'png' | 'jpg' } {
	if (!dataURL || typeof dataURL !== 'string') return { reason: 'dataURL is required' }
	if (fileType !== 'png' && fileType !== 'jpg') return { reason: 'invalid file type' }
	if (!isValidCanvasAppId(appId)) return { reason: 'invalid appId' }

	const prefix = CANVAS_DATA_URL_PREFIX.exec(dataURL)
	if (dataURL.startsWith('data:') && !prefix) return { reason: 'invalid dataURL' }
	const declaredType = prefix?.[1]
	if (declaredType && declaredType !== fileType && !(declaredType === 'jpeg' && fileType === 'jpg')) {
		return { reason: 'file type mismatch' }
	}

	return { base64Data: prefix ? dataURL.slice(prefix[0].length) : dataURL, fileType }
}

// Node/browser `atob` follows WHATWG forgiving-base64: a payload whose length leaves a
// remainder of 2 or 3 still decodes. The native decoders reject it, so the length and
// the alphabet are checked here rather than left to a throw.
function isStrictBase64(base64Data: string): boolean {
	return !!base64Data && base64Data.length % 4 === 0 && STRICT_BASE64.test(base64Data)
}

// Same in-flight budget the three containers apply per appId (android
// MAX_IN_FLIGHT_CANVAS_EXPORTS / MAX_PENDING_CANVAS_BASE64_CHARS, iOS
// maxInFlightCanvasExports, harmony CanvasExportJobRegistry): one export writing while a
// second waits is fine, past that it is just piling up. Each waiting export still holds
// its own copy of the payload, so the budget counts base64 characters, not just calls,
// and it is claimed before anything else takes a reference to the bytes.
const MAX_IN_FLIGHT_CANVAS_EXPORTS = 2
const MAX_PENDING_CANVAS_BASE64_CHARS = MAX_IN_FLIGHT_CANVAS_EXPORTS * MAX_CANVAS_BASE64_CHARS
const pendingCanvasExports = new Map<string, { count: number; chars: number }>()

function reserveCanvasExport(appId: string, chars: number): boolean {
	const state = pendingCanvasExports.get(appId) ?? { count: 0, chars: 0 }
	if (state.count >= MAX_IN_FLIGHT_CANVAS_EXPORTS) return false
	if (state.chars + chars > MAX_PENDING_CANVAS_BASE64_CHARS) return false
	state.count += 1
	state.chars += chars
	pendingCanvasExports.set(appId, state)
	return true
}

function releaseCanvasExport(appId: string, chars: number): void {
	const state = pendingCanvasExports.get(appId)
	if (!state) return
	state.count -= 1
	state.chars -= chars
	if (state.count <= 0) pendingCanvasExports.delete(appId)
}

// Decodes the reserved payload and holds it to the same content rules as the containers:
// the base64 ceiling is only a pre-filter, so the byte count and the file signature are
// checked on the real bytes.
function decodeCanvasBytes(base64Data: string, fileType: 'png' | 'jpg'): { reason: string } | { blob: Blob } {
	let bytes: Uint8Array<ArrayBuffer>
	try {
		const byteChars = atob(base64Data)
		bytes = new Uint8Array(byteChars.length)
		for (let i = 0; i < byteChars.length; i++) {
			bytes[i] = byteChars.charCodeAt(i)
		}
	} catch {
		return { reason: 'base64 decode failed' }
	}

	if (bytes.length > MAX_CANVAS_IMAGE_BYTES) return { reason: 'data too large' }
	if (!matchesImageType(bytes, fileType)) return { reason: 'invalid image data' }

	return { blob: new Blob([bytes], { type: fileType === 'jpg' ? 'image/jpeg' : 'image/png' }) }
}

export async function saveCanvasTempFile(
	this: MiniAppContext,
	{ dataURL, fileType = 'png', success, fail, complete }: { dataURL: string; fileType?: string; success?: unknown; fail?: unknown; complete?: unknown },
) {
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })

	const failWith = (reason: string) => {
		const result = { errMsg: `canvasToTempFilePath:fail ${reason}` }
		onFail?.(result)
		onComplete?.(result)
	}

	// Order and wording of every rejection mirror the native containers (android
	// ImageApi.kt, iOS ImageAPI.swift, harmony DMPContainerBridgesModule+Canvas.ets):
	// the errMsg is what a mini program branches on, so it must not differ per host.
	const head = readCanvasDataURL(dataURL, fileType, this.appId)
	if ('reason' in head) {
		failWith(head.reason)
		return
	}
	const { base64Data, fileType: imageType } = head

	if (base64Data.length > MAX_CANVAS_BASE64_CHARS) {
		failWith('data too large')
		return
	}
	if (!isStrictBase64(base64Data)) {
		failWith('base64 decode failed')
		return
	}
	// Claimed before the decode allocates anything, so a rejected export costs nothing.
	if (!reserveCanvasExport(this.appId, base64Data.length)) {
		failWith('too many pending exports')
		return
	}

	try {
		const decoded = decodeCanvasBytes(base64Data, imageType)
		if ('reason' in decoded) {
			failWith(decoded.reason)
			return
		}
		const tempFilePath = await createTempFilePathAsync(decoded.blob)
		const result = { tempFilePath, errMsg: 'canvasToTempFilePath:ok' }
		onSuccess?.(result)
		onComplete?.(result)
	} catch (error) {
		// The store's own error text (a disposed runtime, a rejected IPC) says nothing
		// to a mini program, and native reports every write failure the same way — keep
		// the cause in the devtools console instead of in errMsg.
		console.warn('[simulator] canvas temp file write failed', error)
		failWith('write failed')
	} finally {
		releaseCanvasExport(this.appId, base64Data.length)
	}
}

export function saveImageToPhotosAlbum(
	this: MiniAppContext,
	{ filePath, success, fail, complete }: { filePath: string; success?: unknown; fail?: unknown; complete?: unknown },
) {
	const { onSuccess, onFail, onComplete } = bindCallbacks(this, { success, fail, complete })

	const triggerDownload = (href: string) => {
		const a = document.createElement('a')
		a.href = href
		a.download = 'image'
		a.click()
	}

	if (typeof filePath === 'string' && filePath.startsWith('difile://_tmp/')) {
		// The simulator's temp-file scheme (chooseImage / chooseMedia /
		// compressImage mint these via createTempFilePath): the bytes live in
		// the renderer Blob registry, so resolution is async. The async branch
		// owns its whole verdict — success/fail strictly before complete.
		resolveTempFilePath(filePath)
			.then(
				blob =>
					new Promise<string>((resolve, reject) => {
						const reader = new FileReader()
						reader.onerror = () => reject(reader.error ?? new Error('blob read failed'))
						reader.onload = () => resolve(String(reader.result))
						reader.readAsDataURL(blob)
					}),
			)
			.then(
				(href) => {
					triggerDownload(href)
					onSuccess?.({ errMsg: 'saveImageToPhotosAlbum:ok' })
					onComplete?.()
				},
				(err: unknown) => {
					const msg = err instanceof Error ? err.message : String(err)
					onFail?.({ errMsg: `saveImageToPhotosAlbum:fail ${msg}` })
					onComplete?.()
				},
			)
		return
	}

	try {
		if (typeof filePath === 'string' && filePath.startsWith('difile://')) {
			const bytes = readVPathBytesSync(filePath)
			if (bytes) {
				// A data: href keeps the whole verdict synchronous (success before
				// complete) without needing URL.createObjectURL.
				triggerDownload(`data:application/octet-stream;base64,${bytes.toString('base64')}`)
				onSuccess?.({ errMsg: 'saveImageToPhotosAlbum:ok' })
			} else {
				onFail?.({ errMsg: 'saveImageToPhotosAlbum:fail no such file' })
			}
		} else {
			// Real dimina clients (Android / iOS / Harmony) only accept a local
			// file path — a dataURL, remote http(s) URL, or blob: URL (which no
			// simulator code path ever mints as a filePath) fails on device, so
			// the simulator must not "succeed" on it either.
			onFail?.({ errMsg: 'saveImageToPhotosAlbum:fail invalid file path' })
		}
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
	const cbs = bindCallbacks(this, { success, fail, complete })
	const { onSuccess, onFail, onComplete } = cbs
	const normalizedCount = normalizeChooseMediaCount(count)
	const normalizedMediaType = normalizeStringArray(mediaType, ['image', 'video'])
	const normalizedSourceType = normalizeStringArray(sourceType, ['album', 'camera'])

	createFilePicker(
		'chooseMedia',
		{
			accept: getChooseMediaAccept(normalizedMediaType),
			multiple: normalizedCount > 1,
			capture: captureAttrFor(normalizedSourceType, camera),
		},
		cbs,
		async (rawFiles, removeInput) => {
			const files = rawFiles.slice(0, normalizedCount)
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
				removeInput()
			}
		},
	)
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
	const cbs = bindCallbacks(this, { success, fail, complete })
	const { onSuccess, onComplete } = cbs
	const normalizedSourceType = normalizeStringArray(sourceType, ['album', 'camera'])

	createFilePicker(
		'chooseVideo',
		{ accept: 'video/*', multiple: false, capture: captureAttrFor(normalizedSourceType, camera) },
		cbs,
		async (files, removeInput) => {
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
			removeInput()
		},
	)
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
