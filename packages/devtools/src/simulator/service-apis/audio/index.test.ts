/**
 * Failing tests for the audio EVENT BRIDGE on the service side.
 *
 * Target contract (see task brief):
 *  - InnerAudioContext registers a persistent event subscription at
 *    construction time: an invokeAPI call carrying `keep: true` and a
 *    callback (the "dispatcher" the container invokes when an audio event
 *    happens).
 *  - The dispatcher receives `{ event, currentTime, duration, buffered,
 *    paused }`, updates the instance snapshot fields, then fires every
 *    local listener registered for `event`.
 *  - Read-only getters (`duration` / `currentTime` / `buffered` / `paused`)
 *    reflect the most recent payload instead of being hard-coded to 0.
 *  - play / pause / stop / seek still emit their existing invokeAPI calls.
 *
 * These tests assert OBSERVABLE behavior only; they do not pin the wire
 * method name of the subscription call.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// `../../../common` resolves to `src/common`, which is not a source file
// (it is provided by the dimina container bundle at runtime), so it must be
// mocked for the unit test.
vi.mock('../../../common', () => ({
	invokeAPI: vi.fn(),
}))

// @ts-expect-error -- mocked JS module without type declarations
import { invokeAPI } from '../../../common'
import { createInnerAudioContext } from './index'

const invokeAPIMock = invokeAPI as unknown as ReturnType<typeof vi.fn>

type AudioPayload = {
	event: string
	currentTime: number
	duration: number
	buffered: number
	paused: boolean
}
type Dispatcher = (payload: AudioPayload) => void

/**
 * Inspect the invokeAPI mock and return the callback function passed to the
 * persistent (`keep: true`) subscription call made during construction.
 * This is the "dispatcher" the container will invoke on every audio event.
 */
function captureDispatcher(): Dispatcher | undefined {
	for (const call of invokeAPIMock.mock.calls) {
		const payload = call[1]
		if (payload && typeof payload === 'object' && payload.keep === true) {
			// The callback may be stored under `success` (extOnBridge style)
			// or another key — pick the first function-valued field.
			for (const value of Object.values(payload)) {
				if (typeof value === 'function') return value as Dispatcher
			}
		}
	}
	return undefined
}

beforeEach(() => {
	invokeAPIMock.mockClear()
})

describe('InnerAudioContext – persistent event subscription', () => {
	it('registers a keep:true subscription carrying a dispatcher callback at construction', () => {
		createInnerAudioContext()

		const keepCalls = invokeAPIMock.mock.calls.filter(
			([, payload]) => payload && payload.keep === true,
		)
		expect(keepCalls.length).toBeGreaterThanOrEqual(1)

		const dispatcher = captureDispatcher()
		expect(typeof dispatcher).toBe('function')
	})
})

describe('InnerAudioContext – dispatcher drives listeners + snapshot', () => {
	it('onEnded callbacks fire with the payload when dispatcher receives an ended event', () => {
		const ctx = createInnerAudioContext()
		const dispatcher = captureDispatcher()
		expect(typeof dispatcher).toBe('function')

		const cb = vi.fn()
		ctx.onEnded(cb)

		dispatcher!({ event: 'ended', currentTime: 5, duration: 42, buffered: 30, paused: true })

		expect(cb).toHaveBeenCalledTimes(1)
		expect(cb.mock.calls[0][0]).toMatchObject({
			event: 'ended',
			currentTime: 5,
			duration: 42,
		})
	})

	it('read-only getters reflect the most recent dispatched payload', () => {
		const ctx = createInnerAudioContext()
		const dispatcher = captureDispatcher()

		// before any event the snapshot is the initial 0 state
		expect(ctx.duration).toBe(0)
		expect(ctx.currentTime).toBe(0)

		dispatcher!({ event: 'timeUpdate', currentTime: 5, duration: 42, buffered: 30, paused: false })

		expect(ctx.duration).toBe(42)
		expect(ctx.currentTime).toBe(5)
		expect(ctx.buffered).toBe(30)
		expect(ctx.paused).toBe(false)
	})

	it('only listeners registered for the dispatched event name are invoked', () => {
		const ctx = createInnerAudioContext()
		const dispatcher = captureDispatcher()

		const onEnded = vi.fn()
		const onPlay = vi.fn()
		ctx.onEnded(onEnded)
		ctx.onPlay(onPlay)

		dispatcher!({ event: 'play', currentTime: 0, duration: 42, buffered: 0, paused: false })

		expect(onPlay).toHaveBeenCalledTimes(1)
		expect(onEnded).not.toHaveBeenCalled()
	})

	it('a removed (offTimeUpdate) listener is not invoked by the dispatcher', () => {
		const ctx = createInnerAudioContext()
		const dispatcher = captureDispatcher()

		const cb = vi.fn()
		ctx.onTimeUpdate(cb)
		ctx.offTimeUpdate(cb)

		dispatcher!({ event: 'timeUpdate', currentTime: 1, duration: 10, buffered: 2, paused: false })

		expect(cb).not.toHaveBeenCalled()
	})
})

describe('InnerAudioContext – playback control mapping is unchanged', () => {
	it('play() emits invokeAPI("audioPlay", ...)', () => {
		const ctx = createInnerAudioContext()
		invokeAPIMock.mockClear()
		ctx.play()
		expect(invokeAPIMock).toHaveBeenCalledWith(
			'audioPlay',
			expect.objectContaining({ audioId: expect.anything() }),
		)
	})

	it('pause() emits invokeAPI("audioPause", ...)', () => {
		const ctx = createInnerAudioContext()
		invokeAPIMock.mockClear()
		ctx.pause()
		expect(invokeAPIMock).toHaveBeenCalledWith(
			'audioPause',
			expect.objectContaining({ audioId: expect.anything() }),
		)
	})

	it('stop() emits invokeAPI("audioStop", ...)', () => {
		const ctx = createInnerAudioContext()
		invokeAPIMock.mockClear()
		ctx.stop()
		expect(invokeAPIMock).toHaveBeenCalledWith(
			'audioStop',
			expect.objectContaining({ audioId: expect.anything() }),
		)
	})

	it('seek(pos) emits invokeAPI("audioSeek", ...) with the position', () => {
		const ctx = createInnerAudioContext()
		invokeAPIMock.mockClear()
		ctx.seek(12)
		expect(invokeAPIMock).toHaveBeenCalledWith(
			'audioSeek',
			expect.objectContaining({ position: 12 }),
		)
	})
})
