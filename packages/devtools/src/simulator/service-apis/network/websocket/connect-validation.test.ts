/**
 * `connectSocket` validation: what reaches the container, what is rejected in
 * the script layer, the exact fail text, and the return value in each case.
 *
 * Validation always reports through the fail callback and never throws, and
 * the call never yields a Promise.
 */
import { describe, expect, it, vi } from 'vitest'
import type { BridgeParams, Settler } from './__test-stubs__/harness'
import {
	CLOSED,
	DEFAULT_URL,
	bridgeCalls,
	connectAndOpen,
	invokeAPIMock,
	lastBridgeCall,
	loadSocketModule,
} from './__test-stubs__/harness'

vi.mock('../../../common', () => ({ invokeAPI: invokeAPIMock }))

describe('connectSocket parameter validation', () => {
	it('rejects a missing options object without touching the bridge or throwing', async () => {
		const mod = await loadSocketModule()

		let task: unknown = 'unset'
		expect(() => {
			task = mod.connectSocket()
		}).not.toThrow()

		expect(task).toBeUndefined()
		expect(bridgeCalls('connectSocket')).toHaveLength(0)
	})

	it('rejects a non-object argument the same way', async () => {
		const mod = await loadSocketModule()

		let task: unknown = 'unset'
		expect(() => {
			task = mod.connectSocket(DEFAULT_URL)
		}).not.toThrow()

		expect(task).toBeUndefined()
		expect(bridgeCalls('connectSocket')).toHaveLength(0)
	})

	it('reports a missing url as a parameter error carrying errno 1001', async () => {
		const mod = await loadSocketModule()
		const fail = vi.fn<Settler>()

		const task = mod.connectSocket({ fail })

		expect(fail).toHaveBeenCalledWith({
			errMsg: 'connectSocket:fail parameter error: parameter.url should be String instead of Undefined;',
			errno: 1001,
		})
		expect(task).toBeUndefined()
		expect(bridgeCalls('connectSocket')).toHaveLength(0)
	})

	it('names the actual type when url is not a string', async () => {
		const mod = await loadSocketModule()
		const fail = vi.fn<Settler>()

		mod.connectSocket({ url: 42, fail })

		expect(fail).toHaveBeenCalledWith({
			errMsg: 'connectSocket:fail parameter error: parameter.url should be String instead of Number;',
			errno: 1001,
		})
	})

	it('reports an empty url as an invalid url and carries no errno', async () => {
		const mod = await loadSocketModule()
		const fail = vi.fn<Settler>()

		mod.connectSocket({ url: '', fail })

		expect(fail).toHaveBeenCalledWith({ errMsg: 'connectSocket:fail invalid url ""' })
	})

	it('reports a non-websocket protocol as an invalid url quoting the original', async () => {
		const mod = await loadSocketModule()
		const fail = vi.fn<Settler>()

		mod.connectSocket({ url: 'http://localhost:8080/socket', fail })

		expect(fail).toHaveBeenCalledWith({
			errMsg: 'connectSocket:fail invalid url "http://localhost:8080/socket"',
		})
		expect(bridgeCalls('connectSocket')).toHaveLength(0)
	})

	it('still runs complete after a validation failure', async () => {
		const mod = await loadSocketModule()
		const complete = vi.fn<Settler>()

		mod.connectSocket({ url: '', complete })

		expect(complete).toHaveBeenCalledTimes(1)
	})

	it('checks the url before anything else in the options object', async () => {
		const mod = await loadSocketModule()
		const fail = vi.fn<Settler>()

		mod.connectSocket({ header: 'not-an-object', fail })

		expect(fail).toHaveBeenCalledTimes(1)
		expect(fail).toHaveBeenCalledWith({
			errMsg: 'connectSocket:fail parameter error: parameter.url should be String instead of Undefined;',
			errno: 1001,
		})
	})
})

describe('connectSocket url protocol', () => {
	it('accepts ws:// and forwards the url untouched', async () => {
		const mod = await loadSocketModule()

		mod.connectSocket({ url: 'ws://localhost:8080/socket?a=1' })

		expect(lastBridgeCall('connectSocket').url).toBe('ws://localhost:8080/socket?a=1')
	})

	it('accepts the protocol regardless of case', async () => {
		const mod = await loadSocketModule()
		const fail = vi.fn<Settler>()

		mod.connectSocket({ url: 'WSS://Localhost:8080/Path', fail })

		expect(fail).not.toHaveBeenCalled()
		expect(lastBridgeCall('connectSocket').url).toBe('WSS://Localhost:8080/Path')
	})

	it('forwards a url carrying a fragment to the container instead of judging it here', async () => {
		const mod = await loadSocketModule()
		const fail = vi.fn<Settler>()

		mod.connectSocket({ url: 'ws://localhost:8080/socket#frag', fail })

		expect(fail).not.toHaveBeenCalled()
		expect(lastBridgeCall('connectSocket').url).toBe('ws://localhost:8080/socket#frag')
	})

	it('accepts a bare protocol prefix and lets the container judge it', async () => {
		const mod = await loadSocketModule()
		const fail = vi.fn<Settler>()

		mod.connectSocket({ url: 'ws://', fail })

		expect(fail).not.toHaveBeenCalled()
		expect(bridgeCalls('connectSocket')).toHaveLength(1)
	})
})

describe('connectSocket return value', () => {
	it('returns the SocketTask rather than a Promise when callbacks are supplied', async () => {
		const mod = await loadSocketModule()

		const task = mod.connectSocket({ url: DEFAULT_URL, success: () => {} })

		expect(task).toBeDefined()
		expect(task).not.toBeInstanceOf(Promise)
		expect(typeof task?.send).toBe('function')
	})

	it('returns the SocketTask rather than a Promise when no callback is supplied', async () => {
		const mod = await loadSocketModule()

		const task = mod.connectSocket({ url: DEFAULT_URL })

		expect(task).not.toBeInstanceOf(Promise)
		expect(typeof task?.close).toBe('function')
	})
})

describe('connectSocket when the bridge throws synchronously', () => {
	it('routes the error to fail, returns undefined, and does not rethrow', async () => {
		const mod = await loadSocketModule()
		const fail = vi.fn<Settler>()
		invokeAPIMock.mockImplementation((name: string) => {
			if (name === 'connectSocket') throw new Error('bridge down')
			return undefined
		})

		let task: unknown = 'unset'
		expect(() => {
			task = mod.connectSocket({ url: DEFAULT_URL, fail })
		}).not.toThrow()

		expect(task).toBeUndefined()
		expect(fail).toHaveBeenCalledWith({ errMsg: 'connectSocket:fail bridge down' })
	})

	it('leaves the global binding free for the next connection', async () => {
		const mod = await loadSocketModule()
		invokeAPIMock.mockImplementation((name: string) => {
			if (name === 'connectSocket') throw new Error('bridge down')
			return undefined
		})
		mod.connectSocket({ url: DEFAULT_URL, fail: () => {} })
		invokeAPIMock.mockImplementation(() => undefined)

		const second = connectAndOpen(mod)
		mod.sendSocketMessage({ data: 'ping', success: () => {} })

		expect(lastBridgeCall('sendSocketMessage').socketId).toBe(second.socketId)
	})

	it('does not leave a half-registered task behind that the bridge would report on', async () => {
		const mod = await loadSocketModule()
		invokeAPIMock.mockImplementation((name: string) => {
			if (name === 'connectSocket') throw new Error('bridge down')
			return undefined
		})
		mod.connectSocket({ url: DEFAULT_URL, fail: () => {} })
		invokeAPIMock.mockImplementation(() => undefined)

		const second = connectAndOpen(mod)
		mod.closeSocket({ success: () => {} })

		const closes: BridgeParams[] = bridgeCalls('closeSocket')
		expect(closes).toHaveLength(1)
		expect(closes[0].socketId).toBe(second.socketId)
		expect(second.task.readyState).toBe(CLOSED)
	})
})
