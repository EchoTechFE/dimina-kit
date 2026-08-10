/**
 * How `connectSocket` hands the caller's connection options to the container:
 * the script layer forwards what the caller actually passed, normalizes header
 * values to strings, and never invents values the caller left out.
 */
import { describe, expect, it, vi } from 'vitest'
import type { BridgeParams, Settler } from './__test-stubs__/harness'
import {
	DEFAULT_URL,
	invokeAPIMock,
	isRecord,
	lastBridgeCall,
	loadSocketModule,
} from './__test-stubs__/harness'

vi.mock('../../../common', () => ({ invokeAPI: invokeAPIMock }))

function headerOf(params: BridgeParams): Record<string, unknown> {
	const header = params.header
	if (!isRecord(header)) {
		throw new TypeError('the connectSocket bridge call carries no header object')
	}
	return header
}

describe('connectSocket option defaults', () => {
	it('omits every option the caller left out instead of filling in a value', async () => {
		const mod = await loadSocketModule()

		mod.connectSocket({ url: DEFAULT_URL })

		const params = lastBridgeCall('connectSocket')
		expect('header' in params).toBe(false)
		expect('protocols' in params).toBe(false)
		expect('tcpNoDelay' in params).toBe(false)
		expect('perMessageDeflate' in params).toBe(false)
		expect('forceCellularNetwork' in params).toBe(false)
	})

	it('forwards the options the caller did supply', async () => {
		const mod = await loadSocketModule()

		mod.connectSocket({
			url: DEFAULT_URL,
			protocols: ['chat'],
			tcpNoDelay: true,
			perMessageDeflate: true,
			forceCellularNetwork: true,
		})

		const params = lastBridgeCall('connectSocket')
		expect(params.protocols).toEqual(['chat'])
		expect(params.tcpNoDelay).toBe(true)
		expect(params.perMessageDeflate).toBe(true)
		expect(params.forceCellularNetwork).toBe(true)
	})
})

describe('connectSocket timeout normalization', () => {
	it('forwards a finite timeout unchanged', async () => {
		const mod = await loadSocketModule()

		mod.connectSocket({ url: DEFAULT_URL, timeout: 3000 })

		expect(lastBridgeCall('connectSocket').timeout).toBe(3000)
	})

	it('forwards a negative timeout unchanged and leaves the fallback to the container', async () => {
		const mod = await loadSocketModule()

		mod.connectSocket({ url: DEFAULT_URL, timeout: -1 })

		expect(lastBridgeCall('connectSocket').timeout).toBe(-1)
	})

	it('turns a non-numeric timeout into 0', async () => {
		const mod = await loadSocketModule()

		mod.connectSocket({ url: DEFAULT_URL, timeout: '3000' })

		expect(lastBridgeCall('connectSocket').timeout).toBe(0)
	})

	it('turns NaN into 0 so both sides of the bridge see the same value', async () => {
		const mod = await loadSocketModule()

		mod.connectSocket({ url: DEFAULT_URL, timeout: Number.NaN })

		expect(lastBridgeCall('connectSocket').timeout).toBe(0)
	})

	it('turns Infinity into 0', async () => {
		const mod = await loadSocketModule()

		mod.connectSocket({ url: DEFAULT_URL, timeout: Number.POSITIVE_INFINITY })

		expect(lastBridgeCall('connectSocket').timeout).toBe(0)
	})
})

describe('connectSocket header normalization', () => {
	it('keeps string values and turns numbers into strings', async () => {
		const mod = await loadSocketModule()

		mod.connectSocket({ url: DEFAULT_URL, header: { 'x-token': 'abc', 'x-retry': 2 } })

		expect(headerOf(lastBridgeCall('connectSocket'))).toEqual({
			'x-token': 'abc',
			'x-retry': '2',
		})
	})

	it('turns every other value into its object tag instead of dropping it', async () => {
		const mod = await loadSocketModule()

		mod.connectSocket({
			url: DEFAULT_URL,
			header: {
				'x-object': { a: 1 },
				'x-array': [1, 2],
				'x-null': null,
				'x-undefined': undefined,
				'x-boolean': true,
				'x-function': () => {},
			},
		})

		expect(headerOf(lastBridgeCall('connectSocket'))).toEqual({
			'x-object': '[object Object]',
			'x-array': '[object Array]',
			'x-null': '[object Null]',
			'x-undefined': '[object Undefined]',
			'x-boolean': '[object Boolean]',
			'x-function': '[object Function]',
		})
	})

	it('keeps header names that differ only in case as separate entries', async () => {
		const mod = await loadSocketModule()

		mod.connectSocket({ url: DEFAULT_URL, header: { 'X-Token': 'upper', 'x-token': 'lower' } })

		expect(headerOf(lastBridgeCall('connectSocket'))).toEqual({
			'X-Token': 'upper',
			'x-token': 'lower',
		})
	})

	it('drops a header that is not an object without reporting a failure', async () => {
		const mod = await loadSocketModule()
		const fail = vi.fn<Settler>()

		mod.connectSocket({ url: DEFAULT_URL, header: 'x-token: abc', fail })

		expect(fail).not.toHaveBeenCalled()
		expect('header' in lastBridgeCall('connectSocket')).toBe(false)
	})

	it('normalizes an array header into an index-keyed map', async () => {
		const mod = await loadSocketModule()

		mod.connectSocket({ url: DEFAULT_URL, header: ['abc'] })

		expect(headerOf(lastBridgeCall('connectSocket'))).toEqual({ '0': 'abc' })
	})

	it('sends an empty header object when the caller passes null', async () => {
		const mod = await loadSocketModule()

		mod.connectSocket({ url: DEFAULT_URL, header: null })

		expect(headerOf(lastBridgeCall('connectSocket'))).toEqual({})
	})

	it('does not inject an Origin header of its own', async () => {
		const mod = await loadSocketModule()

		mod.connectSocket({ url: DEFAULT_URL, header: { 'x-token': 'abc' } })

		const names = Object.keys(headerOf(lastBridgeCall('connectSocket'))).map((name) =>
			name.toLowerCase(),
		)
		expect(names).not.toContain('origin')
	})
})
