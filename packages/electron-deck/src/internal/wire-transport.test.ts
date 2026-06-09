// CONTRACT-OBJECTION: `invokeHost` / `invokeSimulator` 是 framework-internal
// async functions —— 让 WireTransport 自己接 throw 转 InvokeFailure 是合理的，
// 但同时上层 deck-app 也可能想统一 error mapping。当前 spec 让
// WireTransport 兼做 error → wire-failure 序列化，意味着 `DeckRemoteError`
// 类的 code-preservation 语义被分散到两处实现（deck-app 与 wire-transport），
// 后续可以考虑抽一个 toInvokeFailure(name, err) helper 复用。

import { describe, expect, it, vi } from 'vitest'
import { DeckRemoteError } from '../errors.js'
import type { JsonValue, SenderPolicy } from '../types.js'
import {
	BRIDGE_PROTOCOL_VERSION,
	DeckChannel,
} from '../shared/protocol.js'
import { EventBus } from './event-bus.js'
import type {
	MinimalIpcMain,
	MinimalWebContents,
	WireTransportDeps,
} from './wire-transport.js'
import { WireTransport } from './wire-transport.js'

// ── fixtures ────────────────────────────────────────────────────────────

type InvokeHandler = (
	event: { sender: { id: number } },
	...args: unknown[]
) => unknown | Promise<unknown>

interface FakeIpcMain extends MinimalIpcMain {
	handle: ReturnType<typeof vi.fn> & MinimalIpcMain['handle']
	removeHandler: ReturnType<typeof vi.fn> & MinimalIpcMain['removeHandler']
	handlers: Map<string, InvokeHandler>
}

function createFakeIpcMain(): FakeIpcMain {
	const handlers = new Map<string, InvokeHandler>()
	const handle = vi.fn((channel: string, handler: InvokeHandler) => {
		handlers.set(channel, handler)
	}) as FakeIpcMain['handle']
	const removeHandler = vi.fn((channel: string) => {
		handlers.delete(channel)
	}) as FakeIpcMain['removeHandler']
	return { handle, removeHandler, handlers }
}

interface FakeWebContents extends MinimalWebContents {
	send: ReturnType<typeof vi.fn> & MinimalWebContents['send']
	destroyed: boolean
}

function createFakeWebContents(id: number, opts: { destroyed?: boolean } = {}): FakeWebContents {
	const wc: FakeWebContents = {
		id,
		destroyed: opts.destroyed ?? false,
		isDestroyed() {
			return wc.destroyed
		},
		send: vi.fn() as FakeWebContents['send'],
	}
	return wc
}

function createFakeSenderPolicy(trustedIds: Set<number>): SenderPolicy {
	return {
		isTrusted: (id: number) => trustedIds.has(id),
	}
}

interface Harness {
	transport: WireTransport
	ipcMain: FakeIpcMain
	bus: EventBus
	senderPolicy: SenderPolicy
	trusted: Set<number>
	wcs: FakeWebContents[]
	invokeHost: ReturnType<typeof vi.fn>
	invokeSimulator: ReturnType<typeof vi.fn>
	getInvokeHandler: () => InvokeHandler
	getProbeHandler: () => InvokeHandler
}

function makeHarness(opts: {
	trustedIds?: number[]
	webContents?: FakeWebContents[]
	invokeHost?: WireTransportDeps['invokeHost']
	invokeSimulator?: WireTransportDeps['invokeSimulator']
	declaredEvents?: WireTransportDeps['declaredEvents']
} = {}): Harness {
	const ipcMain = createFakeIpcMain()
	const bus = new EventBus()
	const trusted = new Set<number>(opts.trustedIds ?? [])
	const senderPolicy = createFakeSenderPolicy(trusted)
	const wcs = opts.webContents ?? []
	const invokeHost = vi.fn(
		opts.invokeHost ?? (async () => null as JsonValue),
	)
	const invokeSimulator = vi.fn(
		opts.invokeSimulator ?? (async () => null as JsonValue),
	)
	const transport = new WireTransport({
		ipcMain,
		bus,
		senderPolicy,
		trustedWebContents: () => wcs,
		invokeHost: invokeHost as WireTransportDeps['invokeHost'],
		invokeSimulator: invokeSimulator as WireTransportDeps['invokeSimulator'],
		// 默认 fanout 测试都 publish 'e1'，统一 allowlist 让既有 case 通过。
		declaredEvents: opts.declaredEvents ?? (() => ['e1']),
	})
	return {
		transport,
		ipcMain,
		bus,
		senderPolicy,
		trusted,
		wcs,
		invokeHost,
		invokeSimulator,
		getInvokeHandler: () => {
			const h = ipcMain.handlers.get(DeckChannel.Invoke)
			if (!h) throw new Error('invoke handler not registered')
			return h
		},
		getProbeHandler: () => {
			const h = ipcMain.handlers.get(DeckChannel.Probe)
			if (!h) throw new Error('probe handler not registered')
			return h
		},
	}
}

// ── tests ───────────────────────────────────────────────────────────────

describe('WireTransport — start()', () => {
	it('registers ipcMain.handle for __electron-deck:invoke and __electron-deck:probe each exactly once', () => {
		const h = makeHarness()
		h.transport.start()
		expect(h.ipcMain.handle).toHaveBeenCalledTimes(2)
		const channels = h.ipcMain.handle.mock.calls.map(c => c[0] as string).sort()
		expect(channels).toEqual([DeckChannel.Invoke, DeckChannel.Probe].sort())
	})

	it('start() called twice throws (already started)', () => {
		const h = makeHarness()
		h.transport.start()
		expect(() => h.transport.start()).toThrow(/already started|already/i)
	})

	// codex review #13 (C9): start() 中途抛错时必须回滚已注册的 handler / 已建的
	// bus subscription，并把 state 回到 idle —— 否则遗留半状态会让 dispose() 走
	// "idle no-op" 分支跳过 cleanup，造成 listener 泄露。
	describe('start() partial-failure rollback (codex #13)', () => {
		it('second ipcMain.handle throws → already-registered handler is removed + state reverts to idle', () => {
			const ipcMain = createFakeIpcMain()
			let callCount = 0
			ipcMain.handle = vi.fn((channel: string, handler: InvokeHandler) => {
				callCount += 1
				if (callCount === 2) {
					throw new Error('boom')
				}
				ipcMain.handlers.set(channel, handler)
			}) as FakeIpcMain['handle']
			const bus = new EventBus()
			const senderPolicy = createFakeSenderPolicy(new Set([1]))
			const transport = new WireTransport({
				ipcMain,
				bus,
				senderPolicy,
				trustedWebContents: () => [],
				invokeHost: async () => null as JsonValue,
				invokeSimulator: async () => null as JsonValue,
				declaredEvents: () => ['e1'],
			})

			expect(() => transport.start()).toThrow(/boom/)

			// 第一次成功的 channel 必须被 removeHandler 清掉。
			expect(ipcMain.removeHandler).toHaveBeenCalled()
			const firstRegisteredChannel = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
			expect(
				(ipcMain.removeHandler as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]),
			).toContain(firstRegisteredChannel)
		})

		it('after start() failure, state is idle so start() can be re-attempted (single-use lock not engaged)', () => {
			const ipcMain = createFakeIpcMain()
			let callCount = 0
			// 配置：每次第二个 handle() 都抛 —— 反复 start 都失败但状态保持自洽。
			ipcMain.handle = vi.fn((channel: string, handler: InvokeHandler) => {
				callCount += 1
				if (callCount % 2 === 0) {
					throw new Error('boom')
				}
				ipcMain.handlers.set(channel, handler)
			}) as FakeIpcMain['handle']
			const bus = new EventBus()
			const senderPolicy = createFakeSenderPolicy(new Set([1]))
			const transport = new WireTransport({
				ipcMain,
				bus,
				senderPolicy,
				trustedWebContents: () => [],
				invokeHost: async () => null as JsonValue,
				invokeSimulator: async () => null as JsonValue,
				declaredEvents: () => ['e1'],
			})

			expect(() => transport.start()).toThrow(/boom/)
			// 状态回 idle —— 再 start() 不应抛 "already started"；mock 仍配置抛
			// boom，因此仍抛 boom（而非 "already started"）。
			expect(() => transport.start()).toThrow(/boom/)
		})

		it('bus.subscribeAll throwing rolls back both ipc handlers', () => {
			const ipcMain = createFakeIpcMain()
			const bus = new EventBus()
			// patch subscribeAll to throw on first call.
			const origSubscribeAll = bus.subscribeAll.bind(bus)
			let subCalls = 0
			bus.subscribeAll = vi.fn((fn) => {
				subCalls += 1
				if (subCalls === 1) {
					throw new Error('sub-boom')
				}
				return origSubscribeAll(fn)
			}) as EventBus['subscribeAll']
			const senderPolicy = createFakeSenderPolicy(new Set([1]))
			const transport = new WireTransport({
				ipcMain,
				bus,
				senderPolicy,
				trustedWebContents: () => [],
				invokeHost: async () => null as JsonValue,
				invokeSimulator: async () => null as JsonValue,
				declaredEvents: () => ['e1'],
			})

			expect(() => transport.start()).toThrow(/sub-boom/)

			// 两个 ipc handler 都注册过 → 都应被 removeHandler 清掉。
			expect(ipcMain.handle).toHaveBeenCalledTimes(2)
			const removed = (ipcMain.removeHandler as ReturnType<typeof vi.fn>).mock.calls
				.map(c => c[0] as string)
				.sort()
			expect(removed).toEqual([DeckChannel.Invoke, DeckChannel.Probe].sort())
		})
	})
})

describe('WireTransport — probe handler', () => {
	it('returns { ready: true, version: BRIDGE_PROTOCOL_VERSION } regardless of sender', async () => {
		const h = makeHarness({ trustedIds: [] })
		h.transport.start()
		const probe = h.getProbeHandler()
		const res = await probe({ sender: { id: 999 } })
		expect(res).toEqual({ ready: true, version: BRIDGE_PROTOCOL_VERSION })
	})

	it('probe also works for a trusted sender (same result)', async () => {
		const h = makeHarness({ trustedIds: [1] })
		h.transport.start()
		const probe = h.getProbeHandler()
		const res = await probe({ sender: { id: 1 } })
		expect(res).toEqual({ ready: true, version: BRIDGE_PROTOCOL_VERSION })
	})
})

describe('WireTransport — invoke handler: senderPolicy gating', () => {
	it('untrusted sender → InvokeFailure with code UNTRUSTED_SENDER and does NOT call host/sim handlers', async () => {
		const h = makeHarness({ trustedIds: [] })
		h.transport.start()
		const invoke = h.getInvokeHandler()
		const res = (await invoke(
			{ sender: { id: 42 } },
			{ kind: 'host', name: 'doThing', args: [1, 2] },
		)) as { ok: false, error: { remoteName: string, code?: string } }
		expect(res.ok).toBe(false)
		expect(res.error.code).toBe('DECK_UNTRUSTED_SENDER')
		expect(res.error.remoteName).toBe('doThing')
		expect(h.invokeHost).not.toHaveBeenCalled()
		expect(h.invokeSimulator).not.toHaveBeenCalled()
	})

	it('trusted sender → forwards to invokeHost for kind:host', async () => {
		const h = makeHarness({
			trustedIds: [7],
			invokeHost: async () => 'result-A' as JsonValue,
		})
		h.transport.start()
		const invoke = h.getInvokeHandler()
		const res = (await invoke(
			{ sender: { id: 7 } },
			{ kind: 'host', name: 'fn', args: [] },
		)) as { ok: true, result: JsonValue }
		expect(res.ok).toBe(true)
		expect(res.result).toBe('result-A')
		expect(h.invokeHost).toHaveBeenCalledTimes(1)
	})
})

describe('WireTransport — invoke handler: kind routing', () => {
	it('kind: host → calls invokeHost(name, args) and wraps in InvokeSuccess; does NOT call invokeSimulator', async () => {
		const h = makeHarness({
			trustedIds: [1],
			invokeHost: async () => ({ ok: 'host' } as unknown as JsonValue),
		})
		h.transport.start()
		const invoke = h.getInvokeHandler()
		const res = (await invoke(
			{ sender: { id: 1 } },
			{ kind: 'host', name: 'svc', args: [10, 20] },
		)) as { ok: true, result: JsonValue }
		expect(res.ok).toBe(true)
		expect(res.result).toEqual({ ok: 'host' })
		expect(h.invokeHost).toHaveBeenCalledTimes(1)
		// ctx is threaded as the required 3rd arg (senderId from the gated sender,
		// senderFrame null for the frame-unaware stub).
		expect(h.invokeHost).toHaveBeenCalledWith('svc', [10, 20], { senderId: 1, senderFrame: null })
		expect(h.invokeSimulator).not.toHaveBeenCalled()
	})

	it('kind: simulator → calls invokeSimulator(name, args); does NOT call invokeHost', async () => {
		const h = makeHarness({
			trustedIds: [1],
			invokeSimulator: async () => 'sim-ok' as JsonValue,
		})
		h.transport.start()
		const invoke = h.getInvokeHandler()
		const res = (await invoke(
			{ sender: { id: 1 } },
			{ kind: 'simulator', name: 'getStorage', args: ['key'] },
		)) as { ok: true, result: JsonValue }
		expect(res.ok).toBe(true)
		expect(res.result).toBe('sim-ok')
		expect(h.invokeSimulator).toHaveBeenCalledTimes(1)
		// ctx threaded as the required 3rd arg (see kind:host case above).
		expect(h.invokeSimulator).toHaveBeenCalledWith('getStorage', ['key'], { senderId: 1, senderFrame: null })
		expect(h.invokeHost).not.toHaveBeenCalled()
	})

	it('unknown kind → InvokeFailure with code UNKNOWN_KIND; does NOT dispatch', async () => {
		const h = makeHarness({ trustedIds: [1] })
		h.transport.start()
		const invoke = h.getInvokeHandler()
		const res = (await invoke(
			{ sender: { id: 1 } },
			{ kind: 'weirdo', name: 'x', args: [] },
		)) as { ok: false, error: { remoteName: string, code?: string } }
		expect(res.ok).toBe(false)
		expect(res.error.code).toBe('DECK_UNKNOWN_KIND')
		expect(res.error.remoteName).toBe('x')
		expect(h.invokeHost).not.toHaveBeenCalled()
		expect(h.invokeSimulator).not.toHaveBeenCalled()
	})
})

describe('WireTransport — invoke handler: error serialization', () => {
	it('plain Error("boom") → InvokeFailure { message: "boom", code: undefined }', async () => {
		const h = makeHarness({
			trustedIds: [1],
			invokeHost: async () => {
				throw new Error('boom')
			},
		})
		h.transport.start()
		const invoke = h.getInvokeHandler()
		const res = (await invoke(
			{ sender: { id: 1 } },
			{ kind: 'host', name: 'fn', args: [] },
		)) as { ok: false, error: { remoteName: string, message: string, code?: string } }
		expect(res.ok).toBe(false)
		expect(res.error.remoteName).toBe('fn')
		expect(res.error.message).toBe('boom')
		expect(res.error.code).toBeUndefined()
	})

	it('object with `code` field preserves code in InvokeFailure', async () => {
		const h = makeHarness({
			trustedIds: [1],
			invokeHost: async () => {
				const err = new Error('x') as Error & { code?: string }
				err.name = 'CustomErr'
				err.code = 'E_FOO'
				throw err
			},
		})
		h.transport.start()
		const invoke = h.getInvokeHandler()
		const res = (await invoke(
			{ sender: { id: 1 } },
			{ kind: 'host', name: 'fn', args: [] },
		)) as { ok: false, error: { code?: string, message: string } }
		expect(res.ok).toBe(false)
		expect(res.error.code).toBe('E_FOO')
		expect(res.error.message).toBe('x')
	})

	// codex review #3: host 抛 DeckRemoteError 重抛代理调用结果时，原 remoteName
	// 必须被保留 —— 不能被中间环节的 invoke name 覆盖。
	it('host throwing DeckRemoteError preserves original remoteName + code (codex #3)', async () => {
		const h = makeHarness({
			trustedIds: [1],
			invokeHost: async () => {
				throw new DeckRemoteError('downstream.svc', 'upstream failed', 'E_UPSTREAM')
			},
		})
		h.transport.start()
		const invoke = h.getInvokeHandler()
		const res = (await invoke(
			{ sender: { id: 1 } },
			{ kind: 'host', name: 'proxyCall', args: [] },
		)) as { ok: false, error: { remoteName: string, message: string, code?: string } }
		expect(res.ok).toBe(false)
		expect(res.error.remoteName).toBe('downstream.svc')
		expect(res.error.code).toBe('E_UPSTREAM')
		expect(res.error.message).toBe('upstream failed')
	})

	// codex review #9 (R8): DeckRemoteError 携带显式空字符串 remoteName 时
	// 表达 "未知来源" 的意图，不能被 invokeName 友好覆盖（`||` → `??`）。
	it('host throwing DeckRemoteError with empty remoteName preserves "" (codex #9 — ?? over ||)', async () => {
		const h = makeHarness({
			trustedIds: [1],
			invokeHost: async () => {
				throw new DeckRemoteError('', 'msg', 'E_FOO')
			},
		})
		h.transport.start()
		const invoke = h.getInvokeHandler()
		const res = (await invoke(
			{ sender: { id: 1 } },
			{ kind: 'host', name: 'proxyCall', args: [] },
		)) as { ok: false, error: { remoteName: string, message: string, code?: string } }
		expect(res.ok).toBe(false)
		expect(res.error.remoteName).toBe('')
		expect(res.error.code).toBe('E_FOO')
		expect(res.error.message).toBe('msg')
	})

	it('non-Error rejection (string / number / null) does NOT crash and stringifies to message', async () => {
		// string
		{
			const h = makeHarness({
				trustedIds: [1],
				 
				invokeHost: () => Promise.reject('plain string'),
			})
			h.transport.start()
			const invoke = h.getInvokeHandler()
			const res = (await invoke(
				{ sender: { id: 1 } },
				{ kind: 'host', name: 'fn', args: [] },
			)) as { ok: false, error: { message: string } }
			expect(res.ok).toBe(false)
			expect(typeof res.error.message).toBe('string')
			expect(res.error.message).toMatch(/plain string/)
		}
		// number
		{
			const h = makeHarness({
				trustedIds: [1],
				 
				invokeHost: () => Promise.reject(42),
			})
			h.transport.start()
			const invoke = h.getInvokeHandler()
			const res = (await invoke(
				{ sender: { id: 1 } },
				{ kind: 'host', name: 'fn', args: [] },
			)) as { ok: false, error: { message: string } }
			expect(res.ok).toBe(false)
			expect(typeof res.error.message).toBe('string')
			expect(res.error.message).toMatch(/42/)
		}
		// null
		{
			const h = makeHarness({
				trustedIds: [1],
				 
				invokeHost: () => Promise.reject(null),
			})
			h.transport.start()
			const invoke = h.getInvokeHandler()
			const res = (await invoke(
				{ sender: { id: 1 } },
				{ kind: 'host', name: 'fn', args: [] },
			)) as { ok: false, error: { message: string } }
			expect(res.ok).toBe(false)
			expect(typeof res.error.message).toBe('string')
		}
	})
})

describe('WireTransport — invoke handler: request shape validation', () => {
	const trustedSender = { sender: { id: 1 } }

	async function callInvoke(payload: unknown): Promise<{ ok: false, error: { remoteName: string, code?: string } }> {
		const h = makeHarness({ trustedIds: [1] })
		h.transport.start()
		const invoke = h.getInvokeHandler()
		const res = await invoke(trustedSender, payload) as { ok: false, error: { remoteName: string, code?: string } }
		// Tag the harness on the result so callers can assert non-dispatch.
		;(res as unknown as { _h?: Harness })._h = h
		return res
	}

	it('request not a plain object → BAD_REQUEST and does NOT dispatch', async () => {
		const res = await callInvoke('not-an-object')
		expect(res.ok).toBe(false)
		expect(res.error.code).toBe('DECK_BAD_REQUEST')
		expect(res.error.remoteName).toBe('unknown')
		const h = (res as unknown as { _h: Harness })._h
		expect(h.invokeHost).not.toHaveBeenCalled()
		expect(h.invokeSimulator).not.toHaveBeenCalled()
	})

	it('request missing kind → BAD_REQUEST', async () => {
		const res = await callInvoke({ name: 'fn', args: [] })
		expect(res.ok).toBe(false)
		expect(res.error.code).toBe('DECK_BAD_REQUEST')
	})

	it('request missing name → BAD_REQUEST', async () => {
		const res = await callInvoke({ kind: 'host', args: [] })
		expect(res.ok).toBe(false)
		expect(res.error.code).toBe('DECK_BAD_REQUEST')
	})

	it('request args not array → BAD_REQUEST', async () => {
		const res = await callInvoke({ kind: 'host', name: 'fn', args: 'not-array' })
		expect(res.ok).toBe(false)
		expect(res.error.code).toBe('DECK_BAD_REQUEST')
	})

	it('null request body → BAD_REQUEST (does not throw inside handler)', async () => {
		const res = await callInvoke(null)
		expect(res.ok).toBe(false)
		expect(res.error.code).toBe('DECK_BAD_REQUEST')
	})
})

describe('WireTransport — event push', () => {
	it('publish on bus fans out to every non-destroyed trusted webContents via send(__electron-deck:event, envelope)', () => {
		const wc1 = createFakeWebContents(1)
		const wc2 = createFakeWebContents(2)
		const h = makeHarness({ trustedIds: [1, 2], webContents: [wc1, wc2] })
		h.transport.start()
		h.bus.publish('e1', { x: 1 })
		expect(wc1.send).toHaveBeenCalledTimes(1)
		expect(wc1.send).toHaveBeenCalledWith(DeckChannel.Event, {
			name: 'e1',
			payload: { x: 1 },
		})
		expect(wc2.send).toHaveBeenCalledTimes(1)
		expect(wc2.send).toHaveBeenCalledWith(DeckChannel.Event, {
			name: 'e1',
			payload: { x: 1 },
		})
	})

	it('destroyed webContents are skipped (isDestroyed === true)', () => {
		const wcLive = createFakeWebContents(1)
		const wcDead = createFakeWebContents(2, { destroyed: true })
		const h = makeHarness({ trustedIds: [1, 2], webContents: [wcLive, wcDead] })
		h.transport.start()
		h.bus.publish('e1', { x: 1 })
		expect(wcLive.send).toHaveBeenCalledTimes(1)
		expect(wcDead.send).not.toHaveBeenCalled()
	})

	it('trustedWebContents() is a lazy snapshot — called fresh on every publish', () => {
		const snapshot: FakeWebContents[] = []
		const ipcMain = createFakeIpcMain()
		const bus = new EventBus()
		const senderPolicy = createFakeSenderPolicy(new Set([1]))
		const trustedWebContents = vi.fn(() => snapshot as readonly MinimalWebContents[])
		const transport = new WireTransport({
			ipcMain,
			bus,
			senderPolicy,
			trustedWebContents,
			invokeHost: async () => null as JsonValue,
			invokeSimulator: async () => null as JsonValue,
			declaredEvents: () => ['e1'],
		})
		transport.start()
		// No webContents at first.
		bus.publish('e1', { x: 1 })
		expect(trustedWebContents).toHaveBeenCalledTimes(1)
		// Add a webContents AFTER start; next publish should pick it up.
		const wc = createFakeWebContents(1)
		snapshot.push(wc)
		bus.publish('e1', { x: 2 })
		expect(trustedWebContents).toHaveBeenCalledTimes(2)
		expect(wc.send).toHaveBeenCalledTimes(1)
		expect(wc.send).toHaveBeenCalledWith(DeckChannel.Event, {
			name: 'e1',
			payload: { x: 2 },
		})
	})

	// codex review #4: declaredEvents allowlist —— wire transport 不能把任何
	// bus.publish 都跨进程推；未声明 event name 必须 drop（防 framework 内部
	// 误用 bus.publish 时 leak 到 webview）。
	it('publish on undeclared event name is dropped (codex #4 — declaredEvents allowlist)', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
		try {
			const wc = createFakeWebContents(1)
			const ipcMain = createFakeIpcMain()
			const bus = new EventBus()
			const senderPolicy = createFakeSenderPolicy(new Set([1]))
			const transport = new WireTransport({
				ipcMain,
				bus,
				senderPolicy,
				trustedWebContents: () => [wc],
				invokeHost: async () => null as JsonValue,
				invokeSimulator: async () => null as JsonValue,
				declaredEvents: () => ['declared.evt'],
			})
			transport.start()
			bus.publish('undeclared.evt', { x: 1 })
			expect(wc.send).not.toHaveBeenCalled()
			expect(warnSpy).toHaveBeenCalled()
			bus.publish('declared.evt', { x: 2 })
			expect(wc.send).toHaveBeenCalledTimes(1)
			expect(wc.send).toHaveBeenCalledWith(DeckChannel.Event, {
				name: 'declared.evt',
				payload: { x: 2 },
			})
		}
		finally {
			warnSpy.mockRestore()
		}
	})

	// CONTRACT-AMBIGUOUS: spec doesn't say what happens when a webContents.send
	// throws (e.g. unserializable circular payload). My judgement: WireTransport
	// must catch + console.error and continue, otherwise one bad webContents
	// would abort fan-out to all subsequent subscribers and break the
	// invariant "bus.publish() is synchronous fire-and-forget". The user can
	// flip this test if they want bubble-up semantics.
	it('webContents.send throwing on bad payload is caught + logged; other subscribers still notified (CONTRACT-AMBIGUOUS)', () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			const wcBad = createFakeWebContents(1)
			wcBad.send = vi.fn(() => {
				throw new Error('cannot serialize')
			}) as FakeWebContents['send']
			const wcGood = createFakeWebContents(2)
			const h = makeHarness({ trustedIds: [1, 2], webContents: [wcBad, wcGood] })
			h.transport.start()
			expect(() => h.bus.publish('e1', { x: 1 })).not.toThrow()
			expect(wcGood.send).toHaveBeenCalledTimes(1)
			expect(errorSpy).toHaveBeenCalled()
		}
		finally {
			errorSpy.mockRestore()
		}
	})
})

describe('WireTransport — dispose()', () => {
	it('dispose() calls removeHandler for both invoke and probe channels (order unspecified)', () => {
		const h = makeHarness()
		h.transport.start()
		h.transport.dispose()
		expect(h.ipcMain.removeHandler).toHaveBeenCalledTimes(2)
		const removed = h.ipcMain.removeHandler.mock.calls.map(c => c[0] as string).sort()
		expect(removed).toEqual([DeckChannel.Invoke, DeckChannel.Probe].sort())
	})

	it('after dispose(), bus.publish no longer triggers webContents.send', () => {
		const wc = createFakeWebContents(1)
		const h = makeHarness({ trustedIds: [1], webContents: [wc] })
		h.transport.start()
		h.bus.publish('e1', { x: 1 })
		expect(wc.send).toHaveBeenCalledTimes(1)
		h.transport.dispose()
		h.bus.publish('e1', { x: 2 })
		// still only the pre-dispose call
		expect(wc.send).toHaveBeenCalledTimes(1)
	})

	it('dispose() is idempotent — second call neither throws nor double-removes', () => {
		const h = makeHarness()
		h.transport.start()
		h.transport.dispose()
		expect(() => h.transport.dispose()).not.toThrow()
		expect(h.ipcMain.removeHandler).toHaveBeenCalledTimes(2)
	})

	it('dispose() before start() is a no-op (does not throw)', () => {
		const h = makeHarness()
		expect(() => h.transport.dispose()).not.toThrow()
		expect(h.ipcMain.removeHandler).not.toHaveBeenCalled()
	})

	// CONTRACT-AMBIGUOUS: spec doesn't say whether the lifecycle is single-use.
	// My judgement: start → dispose → start MUST throw. A WireTransport instance
	// is tied to a specific framework boot; re-using one after teardown would
	// risk listener leaks (bus subscription wasn't re-claimed) and ambiguous
	// handler ownership across lifecycles. If hot-restart is required, the host
	// should construct a fresh instance.
	it('start → dispose → start throws (single-use lifecycle) (CONTRACT-AMBIGUOUS)', () => {
		const h = makeHarness()
		h.transport.start()
		h.transport.dispose()
		expect(() => h.transport.start()).toThrow()
	})
})
