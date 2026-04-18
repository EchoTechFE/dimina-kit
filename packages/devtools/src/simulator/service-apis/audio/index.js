/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/wx.createInnerAudioContext.html
 *
 * Returns an InnerAudioContext instance.  The service layer runs in a Web
 * Worker where the Audio constructor is unavailable, so all actual playback
 * is delegated to the container layer via invokeAPI.
 */

import { invokeAPI } from '../../../common'

let _nextAudioId = 1

class InnerAudioContext {
	constructor() {
		this._audioId = _nextAudioId++
		this._src = ''
		this._startTime = 0
		this._autoplay = false
		this._loop = false
		this._volume = 1
		this._playbackRate = 1
		this._paused = true

		this._listeners = {}

		invokeAPI('audioCreate', { audioId: this._audioId })
	}

	// ─── Properties ──────────────────────────────────────────────────────

	get src() { return this._src }
	set src(val) {
		this._src = val
		invokeAPI('audioSetProp', {
			audioId: this._audioId,
			prop: 'src',
			value: val,
			startTime: this._startTime,
			loop: this._loop,
			volume: this._volume,
			playbackRate: this._playbackRate,
			autoplay: this._autoplay,
		})
	}

	get startTime() { return this._startTime }
	set startTime(val) {
		this._startTime = Number(val) || 0
		invokeAPI('audioSetProp', { audioId: this._audioId, prop: 'startTime', value: this._startTime })
	}

	get autoplay() { return this._autoplay }
	set autoplay(val) {
		this._autoplay = !!val
		invokeAPI('audioSetProp', { audioId: this._audioId, prop: 'autoplay', value: this._autoplay })
	}

	get loop() { return this._loop }
	set loop(val) {
		this._loop = !!val
		invokeAPI('audioSetProp', { audioId: this._audioId, prop: 'loop', value: this._loop })
	}

	get volume() { return this._volume }
	set volume(val) {
		this._volume = Math.max(0, Math.min(1, Number(val) || 0))
		invokeAPI('audioSetProp', { audioId: this._audioId, prop: 'volume', value: this._volume })
	}

	get playbackRate() { return this._playbackRate }
	set playbackRate(val) {
		this._playbackRate = Number(val) || 1
		invokeAPI('audioSetProp', { audioId: this._audioId, prop: 'playbackRate', value: this._playbackRate })
	}

	// Read-only properties – actual values live in the container; return
	// local approximations (the container cannot send data back easily).
	get duration() { return 0 }
	get currentTime() { return 0 }
	get paused() { return this._paused }
	get buffered() { return 0 }

	// ─── Playback control ────────────────────────────────────────────────

	play() {
		this._paused = false
		invokeAPI('audioPlay', { audioId: this._audioId, src: this._src })
	}

	pause() {
		this._paused = true
		invokeAPI('audioPause', { audioId: this._audioId })
	}

	stop() {
		this._paused = true
		invokeAPI('audioStop', { audioId: this._audioId })
	}

	seek(position) {
		invokeAPI('audioSeek', { audioId: this._audioId, position: Number(position) || 0 })
	}

	destroy() {
		invokeAPI('audioDestroy', { audioId: this._audioId })
		this._listeners = {}
	}

	// ─── Event system ────────────────────────────────────────────────────
	// Events from Audio back to the service layer require a container→service
	// bridge which is not yet available.  Keep the listener API as no-ops so
	// mini-program code that registers callbacks does not throw.

	_on(event, cb) {
		if (typeof cb !== 'function') return
		if (!this._listeners[event]) this._listeners[event] = []
		this._listeners[event].push(cb)
	}

	_off(event, cb) {
		if (!this._listeners[event]) return
		if (cb) {
			this._listeners[event] = this._listeners[event].filter(fn => fn !== cb)
		} else {
			this._listeners[event] = []
		}
	}

	onPlay(cb) { this._on('play', cb) }
	onPause(cb) { this._on('pause', cb) }
	onStop(cb) { this._on('stop', cb) }
	onEnded(cb) { this._on('ended', cb) }
	onError(cb) { this._on('error', cb) }
	onTimeUpdate(cb) { this._on('timeUpdate', cb) }
	onWaiting(cb) { this._on('waiting', cb) }
	onSeeking(cb) { this._on('seeking', cb) }
	onSeeked(cb) { this._on('seeked', cb) }
	onCanplay(cb) { this._on('canplay', cb) }

	offPlay(cb) { this._off('play', cb) }
	offPause(cb) { this._off('pause', cb) }
	offStop(cb) { this._off('stop', cb) }
	offEnded(cb) { this._off('ended', cb) }
	offError(cb) { this._off('error', cb) }
	offTimeUpdate(cb) { this._off('timeUpdate', cb) }
	offWaiting(cb) { this._off('waiting', cb) }
	offSeeking(cb) { this._off('seeking', cb) }
	offSeeked(cb) { this._off('seeked', cb) }
	offCanplay(cb) { this._off('canplay', cb) }
}

export function createInnerAudioContext() {
	return new InnerAudioContext()
}
