/**
 * WireTransport — main 端的真 Electron wire 桥接（Phase 3b）。
 *
 * 责任：
 * - 在 `ipcMain.handle('__workbench:invoke')` / `'__workbench:probe'` 上路由
 *   webview → main 的 RPC 请求，按 `senderPolicy` gating + kind 派发到 host /
 *   simulator handler，序列化成 `InvokeResponse` 帧。
 * - 订阅 framework `EventBus`，把 declared `HostEvent.publish(payload)` 通过
 *   `webContents.send('__workbench:event', envelope)` 推送给所有 trusted
 *   webContents。
 *
 * 该类只持有 deps 引用，不直接 import 'electron'；测试用 plain DI 注入 fake。
 * 生命周期一次性：start → dispose 后不能再 start（避免 listener 泄露 / 句柄
 * 双重注册）；hot-restart 由 host 重新构造新实例。
 *
 * @internal
 */

import { WorkbenchRemoteError } from '../errors.js'
import {
	BRIDGE_PROTOCOL_VERSION,
	WorkbenchChannel,
} from '../shared/protocol.js'
import type {
	EventEnvelope,
	InvokeFailure,
	InvokeRequest,
	InvokeResponse,
	ProbeResponse,
} from '../shared/protocol.js'
import type { Disposable, JsonValue, SenderPolicy } from '../types.js'
import type { EventBus } from './event-bus.js'

/**
 * Framework-reserved invoke failure codes —— 全部带 `WORKBENCH_` 前缀，避免与
 * host 自定义 code 冲突。Client / host 都不应抛同前缀。
 */
export const WORKBENCH_CODE = {
	UntrustedSender: 'WORKBENCH_UNTRUSTED_SENDER',
	UnknownKind: 'WORKBENCH_UNKNOWN_KIND',
	BadRequest: 'WORKBENCH_BAD_REQUEST',
} as const

export interface MinimalIpcMain {
	handle(
		channel: string,
		handler: (event: { sender: { id: number } }, ...args: unknown[]) => unknown | Promise<unknown>,
	): void
	removeHandler(channel: string): void
}

export interface MinimalWebContents {
	readonly id: number
	isDestroyed(): boolean
	send(channel: string, payload: unknown): void
}

export interface WireTransportDeps {
	readonly ipcMain: MinimalIpcMain
	readonly bus: EventBus
	readonly senderPolicy: SenderPolicy
	/** 取当前 trusted webContents 快照；用于 event push 广播。lazy：每次 publish 重调。 */
	readonly trustedWebContents: () => readonly MinimalWebContents[]
	/** 路由 host kind 调用；handler 抛错由 WireTransport 接住 → InvokeFailure */
	readonly invokeHost: (name: string, args: readonly JsonValue[]) => Promise<JsonValue>
	/** 路由 simulator kind 调用；同上 */
	readonly invokeSimulator: (name: string, args: readonly JsonValue[]) => Promise<JsonValue>
	/**
	 * 已声明的 event name 集合，作为 wire fanout 的 allowlist。**必填，
	 * default-deny** —— 未在该集合内的 event name 不会跨进程下发（防止
	 * framework 内部代码意外调 `bus.publish('foo')` 时 leak 给 webview）。
	 * 调用方需保证每次返回的是当前 declared event 名字列表（lazy 快照，每次
	 * publish 重读）。
	 */
	readonly declaredEvents: () => readonly string[]
}

type LifecycleState = 'idle' | 'started' | 'disposed'

export class WireTransport {
	private readonly deps: WireTransportDeps
	private state: LifecycleState = 'idle'
	private busSubscription: Disposable | null = null

	constructor(deps: WireTransportDeps) {
		this.deps = deps
	}

	start(): void {
		if (this.state === 'started') {
			throw new Error('WireTransport already started')
		}
		if (this.state === 'disposed') {
			throw new Error('WireTransport already disposed (single-use lifecycle); construct a new instance to restart')
		}
		this.state = 'started'

		// 注册过程中任何一步抛错，必须回滚已成功的副作用（handler / subscription），
		// 否则会留下半状态：dispose() 看到 state !== 'started' 走 no-op 分支，造成
		// 已注册的 ipcMain handler 永远不被清除。
		const cleanups: Array<() => void> = []
		try {
			this.deps.ipcMain.handle(WorkbenchChannel.Probe, () => this.handleProbe())
			cleanups.push(() => this.tryRemoveHandler(WorkbenchChannel.Probe))

			this.deps.ipcMain.handle(WorkbenchChannel.Invoke, (event, ...args) =>
				this.handleInvoke(event?.sender?.id, args[0]))
			cleanups.push(() => this.tryRemoveHandler(WorkbenchChannel.Invoke))

			this.busSubscription = this.deps.bus.subscribeAll((name, payload) => {
				this.fanoutEvent(name, payload)
			})
			cleanups.push(() => {
				if (this.busSubscription) {
					this.busSubscription.dispose()
					this.busSubscription = null
				}
			})
		}
		catch (err) {
			// 反向回滚已成功的步骤；任何 cleanup 自身抛错都吞掉（仅 log），
			// 保证主 rethrow 链路不被淹没。
			for (let i = cleanups.length - 1; i >= 0; i -= 1) {
				try {
					cleanups[i]?.()
				}
				catch (cleanupErr) {
					console.error('[workbench] start() rollback cleanup failed:', cleanupErr)
				}
			}
			this.state = 'idle'
			throw err
		}
	}

	private tryRemoveHandler(channel: string): void {
		try {
			this.deps.ipcMain.removeHandler(channel)
		}
		catch (e) {
			console.error(`[workbench] removeHandler(${channel}) failed:`, e)
		}
	}

	dispose(): void {
		if (this.state !== 'started') {
			// idle → 标记为 disposed 但不动 ipcMain；disposed → idempotent no-op
			this.state = 'disposed'
			return
		}
		this.state = 'disposed'

		try {
			this.deps.ipcMain.removeHandler(WorkbenchChannel.Invoke)
		}
		catch (e) {
			console.error('[workbench] removeHandler(invoke) failed:', e)
		}
		try {
			this.deps.ipcMain.removeHandler(WorkbenchChannel.Probe)
		}
		catch (e) {
			console.error('[workbench] removeHandler(probe) failed:', e)
		}

		if (this.busSubscription) {
			this.busSubscription.dispose()
			this.busSubscription = null
		}
	}

	private handleProbe(): ProbeResponse {
		return { ready: true, version: BRIDGE_PROTOCOL_VERSION }
	}

	private async handleInvoke(senderId: number | undefined, rawReq: unknown): Promise<InvokeResponse> {
		const validation = validateRequest(rawReq)
		if (!validation.ok) {
			return failure(validation.name, validation.message, WORKBENCH_CODE.BadRequest)
		}
		const req = validation.req

		if (typeof senderId !== 'number' || !this.deps.senderPolicy.isTrusted(senderId)) {
			return failure(req.name, `untrusted sender (id=${String(senderId)})`, WORKBENCH_CODE.UntrustedSender)
		}

		try {
			if (req.kind === 'host') {
				const result = await this.deps.invokeHost(req.name, req.args)
				return { ok: true, result }
			}
			if (req.kind === 'simulator') {
				const result = await this.deps.invokeSimulator(req.name, req.args)
				return { ok: true, result }
			}
			return failure(req.name, `unknown invoke kind: ${String(req.kind)}`, WORKBENCH_CODE.UnknownKind)
		}
		catch (err) {
			return serializeError(req.name, err)
		}
	}

	private fanoutEvent(name: string, payload: JsonValue): void {
		if (this.state !== 'started') return
		// declaredEvents allowlist (default-deny)：框架内部任何代码调
		// bus.publish(name) 而 name 未在 config.events 声明时，跨进程下发就是
		// leak，drop + warn。
		const declared = this.deps.declaredEvents()
		if (!declared.includes(name)) {
			console.warn(`[workbench] dropping undeclared event "${name}" from wire fanout`)
			return
		}
		const env: EventEnvelope = { name, payload }
		let targets: readonly MinimalWebContents[]
		try {
			targets = this.deps.trustedWebContents()
		}
		catch (e) {
			console.error('[workbench] trustedWebContents() threw:', e)
			return
		}
		for (const wc of targets) {
			if (wc.isDestroyed()) continue
			try {
				wc.send(WorkbenchChannel.Event, env)
			}
			catch (e) {
				console.error(`[workbench] webContents.send("${WorkbenchChannel.Event}") failed for wc#${wc.id}:`, e)
			}
		}
	}
}

// ── helpers ─────────────────────────────────────────────────────────────────

type ValidationResult =
	| { ok: true, req: InvokeRequest }
	| { ok: false, name: string, message: string }

function validateRequest(raw: unknown): ValidationResult {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return { ok: false, name: 'unknown', message: 'invoke request must be a plain object' }
	}
	const r = raw as Record<string, unknown>
	const { kind, name, args } = r
	if (typeof kind !== 'string') {
		return {
			ok: false,
			name: typeof name === 'string' ? name : 'unknown',
			message: 'invoke request.kind must be a string',
		}
	}
	if (typeof name !== 'string') {
		return { ok: false, name: 'unknown', message: 'invoke request.name must be a string' }
	}
	if (!Array.isArray(args)) {
		return { ok: false, name, message: 'invoke request.args must be an array' }
	}
	// kind 字符串但值非 host/simulator 不在这里 reject —— handler 走 UNKNOWN_KIND 路径
	return {
		ok: true,
		req: {
			kind: kind as InvokeRequest['kind'],
			name,
			args: args as readonly JsonValue[],
		},
	}
}

function failure(remoteName: string, message: string, code?: string): InvokeFailure {
	return { ok: false, error: { remoteName, message, code } }
}

function serializeError(invokeName: string, err: unknown): InvokeFailure {
	// host 抛 WorkbenchRemoteError 时保留它自带的 remoteName + code（host 用同
	// 一个 error 类做"再次远调"的封装/重抛时，源信息不被中间环节覆盖）。
	if (err instanceof WorkbenchRemoteError) {
		// `??` 而非 `||`：host 显式抛 `new WorkbenchRemoteError('', ...)` 时（空
		// 字符串表 "未知来源" 的意图）保留 ''，不被 invokeName 友好覆盖。
		return failure(err.remoteName ?? invokeName, err.message, err.code)
	}
	if (err instanceof Error) {
		const errAny = err as Error & { code?: unknown }
		const code = typeof errAny.code === 'string' ? errAny.code : undefined
		return failure(invokeName, err.message, code)
	}
	let message: string
	try {
		message = String(err)
	}
	catch {
		message = 'unknown error (failed to stringify)'
	}
	return failure(invokeName, message)
}
