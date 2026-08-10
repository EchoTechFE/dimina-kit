/**
 * The socket facade's public surface: which names the container collects onto
 * `wx`, the shape of a SocketTask instance, and how `readyState` moves.
 *
 * Every named export of this module is collected into `wx.<name>`, so the
 * export set is itself a contract: a name that is not exported is an API that
 * does not exist for mini-app code.
 */
import { describe, expect, it, vi } from 'vitest'
import {
	CLOSED,
	CLOSING,
	CONNECTING,
	OPEN,
	connect,
	connectAndOpen,
	emitNative,
	flushAsyncDispatch,
	invokeAPIMock,
	loadSocketModule,
	loadSocketNamespace,
	nativeCloseEvent,
	nativeErrorEvent,
} from './__test-stubs__/harness'

vi.mock('../../../common', () => ({ invokeAPI: invokeAPIMock }))

const SOCKET_TASK_METHODS = ['close', 'onClose', 'onError', 'onMessage', 'onOpen', 'send']

describe('socket module exports', () => {
	it('exposes exactly the seven socket entry points', async () => {
		const namespace = await loadSocketNamespace()

		expect(Object.keys(namespace).sort()).toEqual([
			'closeSocket',
			'connectSocket',
			'onSocketClose',
			'onSocketError',
			'onSocketMessage',
			'onSocketOpen',
			'sendSocketMessage',
		])
	})

	it('exposes no off-listener entry point', async () => {
		const namespace = await loadSocketNamespace()

		expect('offSocketOpen' in namespace).toBe(false)
		expect('offSocketMessage' in namespace).toBe(false)
		expect('offSocketError' in namespace).toBe(false)
		expect('offSocketClose' in namespace).toBe(false)
	})

	it('does not export the SocketTask class or a module-level readyState', async () => {
		const namespace = await loadSocketNamespace()

		expect('SocketTask' in namespace).toBe(false)
		expect('readyState' in namespace).toBe(false)
	})
})

describe('SocketTask instance shape', () => {
	it('carries exactly the six documented methods on its prototype', async () => {
		const mod = await loadSocketModule()
		const { task } = connect(mod)

		const prototype = Object.getPrototypeOf(task) as object
		const members = Object.getOwnPropertyNames(prototype).filter((name) => name !== 'constructor')
		expect(members.sort()).toEqual(SOCKET_TASK_METHODS)
	})

	it('carries no off-listener method', async () => {
		const mod = await loadSocketModule()
		const { task } = connect(mod)

		expect('offOpen' in task).toBe(false)
		expect('offMessage' in task).toBe(false)
		expect('offError' in task).toBe(false)
		expect('offClose' in task).toBe(false)
	})

	it('keeps the bridge socketId off the instance', async () => {
		const mod = await loadSocketModule()
		const { task, socketId } = connect(mod)

		expect('socketId' in task).toBe(false)
		const ownValues = Object.values(task)
		expect(ownValues).not.toContain(socketId)
	})

	it('exposes readyState as an enumerable, configurable accessor that accepts writes', async () => {
		const mod = await loadSocketModule()
		const { task } = connect(mod)

		const descriptor = Object.getOwnPropertyDescriptor(task, 'readyState')
		expect(descriptor).toBeDefined()
		expect(typeof descriptor?.get).toBe('function')
		expect(typeof descriptor?.set).toBe('function')
		expect(descriptor?.enumerable).toBe(true)
		expect(descriptor?.configurable).toBe(true)

		task.readyState = OPEN
		expect(task.readyState).toBe(OPEN)
	})

	it('exposes the four state constants as writable own properties, not prototype constants', async () => {
		const mod = await loadSocketModule()
		const { task } = connect(mod)

		const expected: Array<[string, number]> = [
			['CONNECTING', CONNECTING],
			['OPEN', OPEN],
			['CLOSING', CLOSING],
			['CLOSED', CLOSED],
		]
		const prototype = Object.getPrototypeOf(task) as object
		for (const [name, value] of expected) {
			const descriptor = Object.getOwnPropertyDescriptor(task, name)
			expect(descriptor?.value).toBe(value)
			expect(descriptor?.writable).toBe(true)
			expect(Object.prototype.hasOwnProperty.call(prototype, name)).toBe(false)
		}
	})
})

describe('SocketTask readyState transitions', () => {
	it('starts out CONNECTING', async () => {
		const mod = await loadSocketModule()
		const { task } = connect(mod)

		expect(task.readyState).toBe(CONNECTING)
	})

	it('turns OPEN once the native open event arrives', async () => {
		const mod = await loadSocketModule()
		const { task } = connectAndOpen(mod)

		expect(task.readyState).toBe(OPEN)
	})

	it('turns CLOSED once the native close event arrives', async () => {
		const mod = await loadSocketModule()
		const { task, socketId } = connectAndOpen(mod)

		emitNative(nativeCloseEvent(socketId, 1000, 'bye'))

		expect(task.readyState).toBe(CLOSED)
	})

	it('turns CLOSED once the native error event arrives', async () => {
		const mod = await loadSocketModule()
		const { task, socketId } = connectAndOpen(mod)

		emitNative(nativeErrorEvent(socketId))
		await flushAsyncDispatch()

		expect(task.readyState).toBe(CLOSED)
	})

	it('never passes through CLOSING, including while a close is in flight', async () => {
		const mod = await loadSocketModule()
		const { task, socketId } = connect(mod)
		const observed: number[] = [task.readyState]

		emitNative({ socketId, event: 'open', header: {}, profile: {} })
		observed.push(task.readyState)
		task.close({ code: 1000 })
		observed.push(task.readyState)
		emitNative(nativeCloseEvent(socketId, 1000, 'bye'))
		observed.push(task.readyState)

		expect(observed).not.toContain(CLOSING)
		expect(observed[observed.length - 1]).toBe(CLOSED)
	})
})
