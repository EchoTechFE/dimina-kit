import { UndeclaredHostEventError } from './errors.js'
import { isHostEvent } from './events.js'
import type { MinimalElectron } from './internal/electron-types.js'
import type { MinimalIpcMain } from './internal/wire-transport.js'
import { DeckApp } from './internal/deck-app.js'
import type { DeckAppOptions } from './internal/deck-app.js'
import type { DeckConfig, DeckOptions } from './types.js'

/**
 * `electronDeck(config, options?)` 是 framework 唯一入口（见 README §3）。
 *
 * - Invalid config → reject `TypeError`，phase 不前进
 * - Valid config → 装配 runtime + 调 `config.setup(runtime)` await 完成 →
 *   resolve。Phase 2 不接 Electron，resolve 后 framework 仍持有运行时；
 *   Phase 4 接 Electron app lifecycle 后，由 Electron event loop 撑住进程，
 *   `electronDeck()` 同样 resolve（host 的 main 文件不需 await 阻塞）。
 *
 * `options` 是测试 / 非 Electron 环境用的注入点（见 {@link DeckOptions}）。
 * 生产路径不传 options：framework `await import('electron')` 取真 `ipcMain` /
 * `BrowserWindow` / `WebContentsView`。
 */
export async function electronDeck(config: DeckConfig, options?: DeckOptions): Promise<void> {
	// Validate config BEFORE attempting electron resolution — invalid configs
	// must reject with TypeError regardless of environment (matches Phase 1
	// contract). Electron load failure is reported separately, only for
	// configs that would otherwise be acceptable.
	validateConfig(config)
	const resolved = await resolveAppOptions(options)
	const app = new DeckApp(config, resolved)
	await app.start()
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
	if (opts?.backend) {
		(out as Mutable<DeckAppOptions>).backend = opts.backend
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

	if (config.simulatorApis !== undefined) {
		validateHandlerMap('simulatorApis', config.simulatorApis)
	}

	if (config.hostServices !== undefined) {
		validateHandlerMap('hostServices', config.hostServices)
	}

	if (config.events !== undefined) {
		if (!Array.isArray(config.events)) {
			throw new TypeError('events must be an array of HostEvent (from defineEvent())')
		}
		for (const ev of config.events) {
			if (!isHostEvent(ev)) {
				throw new TypeError(
					'events: every entry must be a HostEvent produced by defineEvent() — '
					+ 'duck-typed shapes are rejected to avoid bind-time failures',
				)
			}
		}
		const names = new Set<string>()
		for (const ev of config.events) {
			if (names.has(ev.name)) {
				throw new Error(`events: duplicate HostEvent name "${ev.name}"`)
			}
			names.add(ev.name)
		}
	}

	if (config.toolbar !== undefined) {
		const { source, preloadPath, height } = config.toolbar
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
		if (typeof preloadPath !== 'string' || preloadPath.length === 0) {
			throw new TypeError('toolbar.preloadPath is required and must be a non-empty string')
		}
		if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) {
			throw new TypeError('toolbar.height is required and must be a positive finite number')
		}
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
