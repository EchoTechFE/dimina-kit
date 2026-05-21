/**
 * Failing tests for the audio EVENT BRIDGE on the CONTAINER side.
 *
 * Target contract (see task brief):
 *  - For each audio instance the container bridges the HTMLAudioElement DOM
 *    media events (play / pause / ended / error / timeupdate / seeking /
 *    seeked / waiting / canplay) out to the service layer.
 *  - When a DOM event fires, the container calls a `fire` function obtained
 *    via `this.createCallbackFunction(<evtId>)` with a payload
 *    `{ event, currentTime, duration, buffered, paused }`, where `event` is
 *    the mini-program event name (DOM `timeupdate` -> `timeUpdate`).
 *  - `audioStop` additionally fires a synthetic `stop` event.
 *  - Destroying the audio instance unbinds the DOM listeners.
 *
 * These tests assert OBSERVABLE behavior: a DOM event on the container's
 * HTMLAudioElement drives the callback returned by createCallbackFunction.
 * They do not pin the invokeAPI wire method name.
 *
 * The container's audio elements are captured by spying on `new Audio()`,
 * so the test does not depend on any private accessor.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MiniAppContext } from './types'
import * as media from './simulator-api-media'

/** Names already known to NOT be the event-bridge registration handler. */
const KNOWN_NON_BRIDGE = new Set([
	'chooseImage', 'previewImage', 'compressImage', 'saveImageToPhotosAlbum',
	'getImageInfo', 'chooseMedia', 'chooseVideo',
	'__audio_create', '__audio_setProp', '__audio_call',
	'audioCreate', 'audioSetProp', 'audioPlay', 'audioPause', 'audioStop',
	'audioSeek', 'audioDestroy',
])

type AnyFn = (...args: unknown[]) => unknown

/**
 * Locate the audio event-bridge registration handler. It is a new export of
 * the media module that, given an audio instance + an event-callback id,
 * wires the DOM media events of that instance through to the service layer.
 */
function findBridgeHandler(): AnyFn {
	const m = media as unknown as Record<string, unknown>
	if (typeof m.audioListen === 'function') return m.audioListen as AnyFn
	if (typeof m.audioOn === 'function') return m.audioOn as AnyFn
	for (const [name, value] of Object.entries(m)) {
		if (typeof value === 'function' && !KNOWN_NON_BRIDGE.has(name) && /audio/i.test(name)) {
			return value as AnyFn
		}
	}
	throw new Error('no audio event-bridge registration handler exported from simulator-api-media')
}

/**
 * Build a fake MiniAppContext whose createCallbackFunction returns a spy.
 *
 * It mirrors the real container `createCallbackFunction(funcId)`: a callback is
 * only produced for a *truthy* id. So a handler that resolves `fire` from the
 * wrong payload field gets `undefined` and binds nothing — which makes these
 * tests fail instead of silently passing.
 */
function makeContext(fireMock: AnyFn): MiniAppContext {
	return {
		appId: 'test-app',
		createCallbackFunction: vi.fn((funcId: unknown) => (funcId ? fireMock : undefined)),
	} as unknown as MiniAppContext
}

// Capture every HTMLAudioElement the container creates via `new Audio()`.
let createdAudioEls: HTMLAudioElement[] = []
const RealAudio = globalThis.Audio

beforeEach(() => {
	createdAudioEls = []
	vi.stubGlobal('Audio', class extends RealAudio {
		constructor(...args: unknown[]) {
			// @ts-expect-error -- forward to the real Audio constructor
			super(...args)
			createdAudioEls.push(this as unknown as HTMLAudioElement)
		}
	})
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('container audio event bridge', () => {
	it('exports an audio event-bridge registration handler', () => {
		expect(() => findBridgeHandler()).not.toThrow()
	})

	it('DOM timeupdate on the container HTMLAudioElement fires the service callback with event "timeUpdate"', () => {
		const fireMock = vi.fn()
		const ctx = makeContext(fireMock)
		const bridge = findBridgeHandler()

		const audioId = 101
		media.audioCreate.call(ctx, { audioId })
		bridge.call(ctx, { audioId, success: 'evt-101' })

		// The container must have resolved a fire function via createCallbackFunction.
		expect(ctx.createCallbackFunction).toHaveBeenCalled()

		const audioEl = createdAudioEls.at(-1)
		expect(audioEl).toBeInstanceOf(HTMLAudioElement)
		audioEl!.dispatchEvent(new Event('timeupdate'))

		expect(fireMock).toHaveBeenCalled()
		const payload = fireMock.mock.calls.at(-1)?.[0] as Record<string, unknown>
		expect(payload).toMatchObject({ event: 'timeUpdate' })
		expect(payload).toHaveProperty('currentTime')
		expect(payload).toHaveProperty('duration')
		expect(payload).toHaveProperty('paused')
	})

	it('DOM ended event maps to the "ended" mini-program event', () => {
		const fireMock = vi.fn()
		const ctx = makeContext(fireMock)
		const bridge = findBridgeHandler()

		const audioId = 102
		media.audioCreate.call(ctx, { audioId })
		bridge.call(ctx, { audioId, success: 'evt-102' })

		createdAudioEls.at(-1)!.dispatchEvent(new Event('ended'))

		const payload = fireMock.mock.calls.at(-1)?.[0] as Record<string, unknown>
		expect(payload).toMatchObject({ event: 'ended' })
	})

	it('audioStop fires a synthetic "stop" event through the bridge', () => {
		const fireMock = vi.fn()
		const ctx = makeContext(fireMock)
		const bridge = findBridgeHandler()

		const audioId = 103
		media.audioCreate.call(ctx, { audioId })
		bridge.call(ctx, { audioId, success: 'evt-103' })

		media.audioStop.call(ctx, { audioId })

		const events = fireMock.mock.calls.map(c => (c[0] as Record<string, unknown>)?.event)
		expect(events).toContain('stop')
	})

	it('destroying the audio instance unbinds DOM listeners (no more fires)', () => {
		const fireMock = vi.fn()
		const ctx = makeContext(fireMock)
		const bridge = findBridgeHandler()

		const audioId = 104
		media.audioCreate.call(ctx, { audioId })
		bridge.call(ctx, { audioId, success: 'evt-104' })

		const audioEl = createdAudioEls.at(-1)!
		media.audioDestroy.call(ctx, { audioId })
		fireMock.mockClear()

		audioEl.dispatchEvent(new Event('timeupdate'))
		expect(fireMock).not.toHaveBeenCalled()
	})
})
