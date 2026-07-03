import { UndeclaredHostEventError } from './errors.js'
import { isHostEvent } from './events.js'
import type { MinimalElectron } from './internal/electron-types.js'
import type { MinimalIpcMain } from './internal/wire-transport.js'
import { DeckApp } from './internal/deck-app.js'
import type { DeckAppOptions } from './internal/deck-app.js'
import type { DeckConfig, DeckOptions, HostEvent, JsonValue, Runtime, ToolbarContribution } from './types.js'

/**
 * `electronDeck(config, options?)` 是 framework 唯一入口（见 README §3）。
 *
 * - Invalid config → reject `TypeError`，phase 不前进
 * - Valid config → 装配 runtime + 调 `config.setup(runtime)` await 完成 →
 *   resolve。不接 Electron 时，resolve 后 framework 仍持有运行时；
 *   接 Electron app lifecycle 后，由 Electron event loop 撑住进程，
 *   `electronDeck()` 同样 resolve（host 的 main 文件不需 await 阻塞）。
 *
 * backend host（如 devtools）走 `electronDeck({ backend })`——backend 是
 * {@link DeckConfig} 的字段，不再需要空 `{}` + options。
 *
 * `options` 是测试 / 非 Electron 环境用的注入点（见 {@link DeckOptions}）。
 * 生产路径不传 options：framework `await import('electron')` 取真 `ipcMain` /
 * `BrowserWindow` / `WebContentsView`。
 */
export async function electronDeck(config: DeckConfig, options?: DeckOptions): Promise<void> {
	// Validate config BEFORE attempting electron resolution — invalid configs
	// must reject with TypeError regardless of environment. Electron load
	// failure is reported separately, only for
	// configs that would otherwise be acceptable.
	validateConfig(config)
	const resolved = await resolveAppOptions(options)
	if (config.backend) {
		(resolved as Mutable<DeckAppOptions>).backend = config.backend
	}
	const app = new DeckApp(config, resolved)
	await app.start()
}

/**
 * Synchronous launch handle for `electronDeck`.
 *
 * `electronDeck(config)` is `async` and internally `await app.start()` →
 * `await app.whenReady()`. A host ESM main entry doing `await electronDeck(config)`
 * SUSPENDS module evaluation on the whenReady gate — but Electron's `ready` only
 * fires once module evaluation finishes, so the gate never resolves: HARD DEADLOCK.
 *
 * `startElectronDeck` returns a plain handle SYNCHRONOUSLY (NOT a thenable), so a
 * host's top-level `await handle.ready` never sits on the whenReady gate. Assembly
 * still runs STRICTLY AFTER `app.whenReady()` resolves (gating intact inside
 * `app.start()`); `handle.ready` resolves with the {@link Runtime}; `handle.dispose()`
 * tears the app down even if called before the in-flight start finished.
 *
 * Invalid config throws a `TypeError` synchronously (matching `electronDeck`'s
 * validate-first contract) — the error surfaces, never silently deadlocks.
 *
 * `@experimental` No production consumer yet — the only caller in this repo is
 * `packages/devtools/spike/popout/harness.mjs`; devtools' real entry
 * (`launch.ts`) uses `electronDeck({ backend })` instead. Contract may change
 * until a second real consumer adopts it.
 */
export function startElectronDeck(
	config: DeckConfig,
	options?: DeckOptions,
): { ready: Promise<Runtime>, dispose(): Promise<void> } {
	// Validate config SYNCHRONOUSLY (before returning the handle) — invalid configs
	// surface a TypeError at the call, never a silent deadlock.
	validateConfig(config)

	let app: DeckApp | null = null
	const startPromise: Promise<DeckApp> = (async () => {
		const resolved = await resolveAppOptions(options)
		if (config.backend) {
			(resolved as Mutable<DeckAppOptions>).backend = config.backend
		}
		app = new DeckApp(config, resolved)
		// `app.start()` internally `await app.whenReady()` THEN assembles — gating
		// stays intact: no window is constructed before whenReady resolves.
		await app.start()
		return app
	})()

	const ready = startPromise.then(a => a.runtime)
	// Mark `ready` as handled so a fire-and-forget caller (who never reads `ready`,
	// e.g. `startElectronDeck(...)` then `dispose()`) does NOT trigger an
	// unhandledRejection if startup fails — which under strict Electron handling can
	// terminate the process. The caller's own `await handle.ready`
	// still observes the rejection; this extra no-op handler only suppresses the
	// "unhandled" classification, it does not swallow the error for the caller.
	void ready.catch(() => {})

	return {
		ready,
		async dispose(): Promise<void> {
			// dispose-before-ready safety: AWAIT the in-flight start (swallow its error
			// so a failed start still lets dispose clean up), THEN shut down — no race
			// with the rootScope teardown that start() set up. `shutdown()` is
			// idempotent (a second call is a no-op).
			const started = await startPromise.catch(() => null)
			if (started) {
				await started.shutdown()
			}
			else if (app) {
				// start threw post-construction → still tear down the partially-built app.
				await app.shutdown()
			}
		},
	}
}

/**
 * 把公共 `DeckOptions` 解析成 internal {@link DeckAppOptions} —— 在
 * 显式注入不足时 lazy `import('electron')` 兜底。
 *
 * 决策 matrix：
 * - `electron` + `ipcMain` 都显式注入 → 不 lazy import（测试 / production override）
 * - 任一缺失 → `await import('electron')`，用 imported module 兜底缺失字段
 *
 * vitest 下 `await import('electron')` 解析到安装包 entry stub（导出可执行路径
 * 字符串），所以 `ipcMain` / `BrowserWindow` 都是 undefined。我们检测到关键
 * 字段缺失会显式 reject，提示注入 options。
 */
async function resolveAppOptions(opts?: DeckOptions): Promise<DeckAppOptions> {
	if (opts?.electron && opts?.ipcMain) {
		return buildAppOptions(opts.electron, opts.ipcMain, opts)
	}

	let imported: unknown
	try {
		imported = await import('electron')
	}
	catch (e) {
		throw new Error(
			'electronDeck(): unable to load electron — pass options.electron / options.ipcMain '
			+ 'for non-Electron environments. Underlying: ' + String(e),
			{ cause: e },
		)
	}

	const m = imported as { ipcMain?: unknown, BrowserWindow?: unknown, WebContentsView?: unknown }
	const resolvedElectron = opts?.electron ?? (asMinimalElectron(m))
	const resolvedIpcMain = opts?.ipcMain ?? (m.ipcMain as MinimalIpcMain | undefined)

	if (!resolvedIpcMain || !resolvedElectron.BrowserWindow || !resolvedElectron.WebContentsView) {
		throw new Error(
			'electronDeck(): loaded "electron" but it does not expose the main-process surface '
			+ '(ipcMain / BrowserWindow / WebContentsView). This typically means you are running '
			+ 'outside an Electron main process (e.g. vitest under node). Pass options.electron '
			+ 'and options.ipcMain to inject a fake.',
		)
	}

	return buildAppOptions(resolvedElectron, resolvedIpcMain, opts)
}

function asMinimalElectron(m: { BrowserWindow?: unknown, WebContentsView?: unknown }): MinimalElectron {
	// We do not validate shape here — `resolveAppOptions` does the BrowserWindow /
	// WebContentsView presence check before returning. Cast is intentional.
	return m as unknown as MinimalElectron
}

function buildAppOptions(
	electron: MinimalElectron,
	ipcMain: MinimalIpcMain,
	opts: DeckOptions | undefined,
): DeckAppOptions {
	const wireTransport: DeckAppOptions['wireTransport'] = { ipcMain }
	const out: DeckAppOptions = { electron, wireTransport }
	if (opts?.trustedWebContents) {
		(out.wireTransport as Mutable<NonNullable<DeckAppOptions['wireTransport']>>)
			.trustedWebContents = opts.trustedWebContents
	}
	if (opts?.senderPolicy) {
		(out.wireTransport as Mutable<NonNullable<DeckAppOptions['wireTransport']>>)
			.senderPolicy = opts.senderPolicy
	}
	return out
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/**
 * Pure validation：不依赖 Electron / IPC / 任何 framework state，可单独 unit
 * test。每一条检查对应 doc §3.3 字段约束。
 *
 * 验证语义保证：通过 validateConfig 的 config 不会在 framework Bind 阶段被拒。
 * 含 HostEvent 来源、source 互斥、map vs array 等所有"shape 就绪"检查。
 *
 * @internal exported for tests
 */
export function validateConfig(config: DeckConfig): void {
	if (config === null || typeof config !== 'object') {
		throw new TypeError('electronDeck(config): config must be an object')
	}

	validateBackendField(config.backend)

	if (config.simulatorApis !== undefined) {
		validateHandlerMap('simulatorApis', config.simulatorApis)
	}
	if (config.hostServices !== undefined) {
		validateHandlerMap('hostServices', config.hostServices)
	}
	if (config.events !== undefined) {
		validateEventsField(config.events)
	}
	if (config.toolbar !== undefined) {
		validateToolbarField(config.toolbar)
	}
}

function validateBackendField(backend: DeckConfig['backend']): void {
	if (backend === undefined) return
	const candidate = backend as { assemble?: unknown }
	if (candidate === null || typeof candidate !== 'object' || typeof candidate.assemble !== 'function') {
		throw new TypeError('config.backend must be a RuntimeBackend (an object with an assemble() function)')
	}
}

function validateHandlerMap(fieldName: string, value: unknown): void {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`${fieldName} must be an object of handlers`)
	}
	for (const [name, handler] of Object.entries(value as Record<string, unknown>)) {
		if (typeof handler !== 'function') {
			throw new TypeError(`${fieldName}["${name}"] must be a function`)
		}
	}
}

function validateEventsField(events: unknown): void {
	if (!Array.isArray(events)) {
		throw new TypeError('events must be an array of HostEvent (from defineEvent())')
	}
	assertAllHostEvents(events)
	assertUniqueEventNames(events as readonly HostEvent<JsonValue>[])
}

/** duck-typed 事件形状会被拒绝——只接受 `defineEvent()` 产出的真实 HostEvent，避免 bind-time 才炸。 */
function assertAllHostEvents(events: readonly unknown[]): void {
	for (const ev of events) {
		if (!isHostEvent(ev)) {
			throw new TypeError(
				'events: every entry must be a HostEvent produced by defineEvent() — '
				+ 'duck-typed shapes are rejected to avoid bind-time failures',
			)
		}
	}
}

function assertUniqueEventNames(events: readonly HostEvent<JsonValue>[]): void {
	const names = new Set<string>()
	for (const ev of events) {
		if (names.has(ev.name)) {
			throw new Error(`events: duplicate HostEvent name "${ev.name}"`)
		}
		names.add(ev.name)
	}
}

function validateToolbarField(toolbar: ToolbarContribution): void {
	assertToolbarSourceShape(toolbar.source)
	if (typeof toolbar.preloadPath !== 'string' || toolbar.preloadPath.length === 0) {
		throw new TypeError('toolbar.preloadPath is required and must be a non-empty string')
	}
	if (typeof toolbar.height !== 'number' || !Number.isFinite(toolbar.height) || toolbar.height <= 0) {
		throw new TypeError('toolbar.height is required and must be a positive finite number')
	}
}

function assertToolbarSourceShape(source: unknown): void {
	if (source === null || typeof source !== 'object') {
		throw new TypeError('toolbar.source must be { url } or { file }')
	}
	const hasUrl = 'url' in source && typeof (source as { url?: unknown }).url === 'string'
	const hasFile = 'file' in source && typeof (source as { file?: unknown }).file === 'string'
	if (hasUrl && hasFile) {
		throw new TypeError('toolbar.source must be either { url } or { file }, not both')
	}
	if (!hasUrl && !hasFile) {
		throw new TypeError('toolbar.source must be { url } or { file }')
	}
}

/**
 * publish-time guard：HostEvent 未在 `config.events` 中显式列出时阻止 publish。
 * 避免 module-load-order 隐式注册。
 *
 * @internal exported for tests
 */
export function assertEventDeclared(
	declared: ReadonlySet<string>,
	eventName: string,
): void {
	if (!declared.has(eventName)) {
		throw new UndeclaredHostEventError(eventName)
	}
}
