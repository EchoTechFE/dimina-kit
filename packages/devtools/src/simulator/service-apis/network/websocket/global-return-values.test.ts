/**
 * What `wx.sendSocketMessage` and `wx.closeSocket` hand back: the presence of a
 * success / fail / complete KEY selects the callback form, whatever the value
 * under that key is; without any of those keys the call yields a Promise that
 * rejects with the failure result. The container's own return value is never
 * passed through.
 */
import { describe, expect, it, vi } from 'vitest'
import {
	answerBridge,
	connectAndOpen,
	invokeAPIMock,
	loadSocketModule,
} from './__test-stubs__/harness'

vi.mock('../../../common', () => ({ invokeAPI: invokeAPIMock }))

describe('wx.sendSocketMessage return value', () => {
	it('returns undefined when a success callback is supplied', async () => {
		const mod = await loadSocketModule()
		connectAndOpen(mod)

		expect(mod.sendSocketMessage({ data: 'ping', success: () => {} })).toBeUndefined()
	})

	it('returns undefined when the success key is present but holds undefined', async () => {
		const mod = await loadSocketModule()
		connectAndOpen(mod)

		expect(mod.sendSocketMessage({ data: 'ping', success: undefined })).toBeUndefined()
	})

	it('returns undefined when a settler key holds something that is not a function', async () => {
		const mod = await loadSocketModule()
		connectAndOpen(mod)

		expect(mod.sendSocketMessage({ data: 'ping', complete: 'not-a-function' })).toBeUndefined()
	})

	it('does not hand back whatever the container returned', async () => {
		const mod = await loadSocketModule()
		connectAndOpen(mod)
		invokeAPIMock.mockImplementation(() => ({ bridgeReturn: true }))

		expect(mod.sendSocketMessage({ data: 'ping', success: () => {} })).toBeUndefined()
	})

	it('returns a Promise that resolves with the container result when no settler key is supplied', async () => {
		const mod = await loadSocketModule()
		connectAndOpen(mod)
		answerBridge('sendSocketMessage', 'success', { errMsg: 'sendSocketMessage:ok' })

		const result = mod.sendSocketMessage({ data: 'ping' })

		expect(result).toBeInstanceOf(Promise)
		await expect(result).resolves.toEqual({ errMsg: 'sendSocketMessage:ok' })
	})

	it('rejects the Promise with the failure result when there is no connection', async () => {
		const mod = await loadSocketModule()

		const result = mod.sendSocketMessage({ data: 'ping' })

		await expect(result).rejects.toEqual({
			errMsg: 'sendSocketMessage:fail WebSocket is not connected',
		})
	})
})

describe('wx.closeSocket return value', () => {
	it('returns undefined when a complete callback is supplied', async () => {
		const mod = await loadSocketModule()
		connectAndOpen(mod)

		expect(mod.closeSocket({ code: 1000, complete: () => {} })).toBeUndefined()
	})

	it('returns a Promise that resolves with the container result when no settler key is supplied', async () => {
		const mod = await loadSocketModule()
		connectAndOpen(mod)
		answerBridge('closeSocket', 'success', { errMsg: 'closeSocket:ok' })

		const result = mod.closeSocket({ code: 1000 })

		expect(result).toBeInstanceOf(Promise)
		await expect(result).resolves.toEqual({ errMsg: 'closeSocket:ok' })
	})

	it('rejects the Promise with the failure result when there is no connection', async () => {
		const mod = await loadSocketModule()

		const result = mod.closeSocket()

		await expect(result).rejects.toEqual({
			errMsg: 'closeSocket:fail WebSocket is not connected',
		})
	})
})
