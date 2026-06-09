import { describe, expect, it, vi } from 'vitest'
import { UndeclaredHostEventError } from './errors.js'
import { defineEvent } from './events.js'
import type {
	MinimalElectron,
	MinimalRect,
	MinimalBrowserWindow,
	MinimalBrowserWindowOptions,
	MinimalWebContentsLike,
	MinimalWebContentsView,
} from './internal/electron-types.js'
import type { MinimalIpcMain } from './internal/wire-transport.js'
import type { HostEvent, JsonValue, DeckConfig, DeckOptions } from './types.js'
import { assertEventDeclared, validateConfig, electronDeck } from './electron-deck.js'

/**
 * Phase 1 contract tests for the electron-deck package's top-level surface.
 *
 * - validateConfig: pure static validation; no Electron, no IPC.
 * - assertEventDeclared: tiny guard used by publish()-time checks.
 * - electronDeck(config): top-level entry; Phase 1 only validates config and
 *   then throws/rejects with "not implemented yet" for valid configs.
 */

// ── validateConfig ───────────────────────────────────────────────────────

describe('validateConfig', () => {
	it('accepts an empty config object', () => {
		expect(() => validateConfig({})).not.toThrow()
	})

	it('accepts a fully-populated minimal valid config', () => {
		const ev = defineEvent<JsonValue>('ok-event')
		const cfg: DeckConfig = {
			simulatorApis: { foo: () => null },
			hostServices: { bar: () => null },
			events: [ev],
			toolbar: {
				source: { url: 'http://localhost:5173/toolbar' },
				preloadPath: '/abs/preload.js',
				height: 40,
			},
		}
		expect(() => validateConfig(cfg)).not.toThrow()
	})

	it('throws TypeError when config is null', () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(() => validateConfig(null as any)).toThrow(TypeError)
	})

	it('throws TypeError when config is a non-object primitive', () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(() => validateConfig('not an object' as any)).toThrow(TypeError)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(() => validateConfig(42 as any)).toThrow(TypeError)
	})

	it('throws TypeError when a simulatorApis value is not a function', () => {
		expect(() =>
			validateConfig({
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				simulatorApis: { broken: 'oops' as any },
			}),
		).toThrow(TypeError)
	})

	it('rejects array as simulatorApis/hostServices (typeof [] === object)', () => {
		// review-driven: `typeof [] === 'object'`，如果元素都是 function 会
		// 静默通过，但产生数字键的 API 名 "0", "1"。validator 必须显式拒。
		expect(() =>
			validateConfig({
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				simulatorApis: [() => null] as any,
			}),
		).toThrow(TypeError)
		expect(() =>
			validateConfig({
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				hostServices: [() => null] as any,
			}),
		).toThrow(TypeError)
	})

	it('simulatorApis error message names the offending field', () => {
		try {
			validateConfig({
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				simulatorApis: { brokenField: 123 as any },
			})
			throw new Error('expected validateConfig to throw')
		}
		catch (err) {
			expect(err).toBeInstanceOf(TypeError)
			expect((err as Error).message).toContain('brokenField')
		}
	})

	it('throws TypeError when a hostServices value is not a function', () => {
		expect(() =>
			validateConfig({
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				hostServices: { x: {} as any },
			}),
		).toThrow(TypeError)
	})

	it('hostServices error message names the offending field', () => {
		try {
			validateConfig({
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				hostServices: { weirdField: null as any },
			})
			throw new Error('expected validateConfig to throw')
		}
		catch (err) {
			expect(err).toBeInstanceOf(TypeError)
			expect((err as Error).message).toContain('weirdField')
		}
	})

	it('throws TypeError when events is not an array', () => {
		expect(() =>
			validateConfig({
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				events: 'nope' as any,
			}),
		).toThrow(TypeError)
	})

	it('throws TypeError when an events entry is not a HostEvent shape', () => {
		expect(() =>
			validateConfig({
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				events: [{ name: 'x' } as any], // missing publish / on
			}),
		).toThrow(TypeError)
	})

	it('throws TypeError when an events entry is missing `name`', () => {
		const bad = { publish: () => {}, on: () => ({ dispose: () => {} }) }
		expect(() =>
			validateConfig({
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				events: [bad as any],
			}),
		).toThrow(TypeError)
	})

	it('rejects a duck-typed event that is NOT from defineEvent()', () => {
		// review-driven contract: 通过 shape duck typing 的伪事件如果不是
		// defineEvent() 产出，runtime Bind 会拒；validateConfig 也要拒，避免
		// "通过校验但 bind 失败" 的迟到错误。
		const fake = {
			name: 'fake',
			publish: () => {},
			on: () => ({ dispose: () => {} }),
		}
		expect(() =>
			validateConfig({
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				events: [fake as any],
			}),
		).toThrow(TypeError)
	})

	it('throws Error on duplicate event names within events[]', () => {
		const a = defineEvent<JsonValue>('dup-name')
		const b = defineEvent<JsonValue>('dup-name')
		// CONTRACT-AMBIGUOUS: spec says "throw Error" (not TypeError) for the
		// duplicate case. We only assert Error so either choice passes.
		expect(() =>
			validateConfig({
				events: [a as HostEvent<JsonValue>, b as HostEvent<JsonValue>],
			}),
		).toThrow(Error)
	})

	it('throws TypeError when toolbar.source has neither url nor file', () => {
		expect(() =>
			validateConfig({
				toolbar: {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					source: {} as any,
					preloadPath: '/abs/preload.js',
					height: 40,
				},
			}),
		).toThrow(TypeError)
	})

	it('throws TypeError when toolbar.source has BOTH url and file', () => {
		// review-driven: source 必须互斥，避免运行时加载优先级成为隐式行为
		expect(() =>
			validateConfig({
				toolbar: {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					source: { url: 'http://x', file: '/abs/x.html' } as any,
					preloadPath: '/abs/preload.js',
					height: 40,
				},
			}),
		).toThrow(TypeError)
	})

	it('accepts toolbar.source with `file`', () => {
		expect(() =>
			validateConfig({
				toolbar: {
					source: { file: '/abs/toolbar.html' },
					preloadPath: '/abs/preload.js',
					height: 40,
				},
			}),
		).not.toThrow()
	})

	it('throws TypeError when toolbar.preloadPath is not a string', () => {
		expect(() =>
			validateConfig({
				toolbar: {
					source: { url: 'http://x' },
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					preloadPath: 123 as any,
					height: 40,
				},
			}),
		).toThrow(TypeError)
	})

	it('throws TypeError when toolbar.preloadPath is an empty string', () => {
		expect(() =>
			validateConfig({
				toolbar: {
					source: { url: 'http://x' },
					preloadPath: '',
					height: 40,
				},
			}),
		).toThrow(TypeError)
	})

	it('throws TypeError when toolbar.height is zero or negative', () => {
		expect(() =>
			validateConfig({
				toolbar: {
					source: { url: 'http://x' },
					preloadPath: '/abs/preload.js',
					height: 0,
				},
			}),
		).toThrow(TypeError)
		expect(() =>
			validateConfig({
				toolbar: {
					source: { url: 'http://x' },
					preloadPath: '/abs/preload.js',
					height: -5,
				},
			}),
		).toThrow(TypeError)
	})

	it('throws TypeError when toolbar.height is non-finite (NaN / Infinity)', () => {
		expect(() =>
			validateConfig({
				toolbar: {
					source: { url: 'http://x' },
					preloadPath: '/abs/preload.js',
					height: Number.NaN,
				},
			}),
		).toThrow(TypeError)
		expect(() =>
			validateConfig({
				toolbar: {
					source: { url: 'http://x' },
					preloadPath: '/abs/preload.js',
					height: Number.POSITIVE_INFINITY,
				},
			}),
		).toThrow(TypeError)
	})

	it('does not depend on Electron (pure)', () => {
		// Importing this test file proves the module graph does not pull
		// Electron at runtime; calling validateConfig synchronously with a
		// valid input must not throw a missing-Electron error.
		expect(() =>
			validateConfig({
				toolbar: {
					source: { url: 'http://x' },
					preloadPath: '/abs/preload.js',
					height: 40,
				},
			}),
		).not.toThrow()
	})
})

// ── assertEventDeclared ──────────────────────────────────────────────────

describe('assertEventDeclared', () => {
	it('does nothing when the name is in the declared set', () => {
		const set = new Set(['foo', 'bar'])
		expect(() => assertEventDeclared(set, 'foo')).not.toThrow()
		expect(() => assertEventDeclared(set, 'bar')).not.toThrow()
	})

	it('throws UndeclaredHostEventError when the name is missing', () => {
		const set = new Set(['foo'])
		expect(() => assertEventDeclared(set, 'bar')).toThrow(UndeclaredHostEventError)
	})

	it('thrown error carries the offending event name', () => {
		const set = new Set<string>()
		try {
			assertEventDeclared(set, 'missing-event')
			throw new Error('assertEventDeclared should have thrown')
		}
		catch (err) {
			expect(err).toBeInstanceOf(UndeclaredHostEventError)
			expect((err as UndeclaredHostEventError).eventName).toBe('missing-event')
		}
	})
})

// ── electronDeck(config) top-level ──────────────────────────────────────────

describe('electronDeck(config)', () => {
	it('rejects an invalid config with TypeError', async () => {
		// Spec accepts either sync TypeError (before async runtime starts) or
		// async rejection. `await expect(...).rejects` is the lowest common
		// denominator.
		await expect(async () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await electronDeck(null as any)
		}).rejects.toThrow(TypeError)
	})

	it('rejects on simulatorApis value not a function', async () => {
		await expect(async () => {
			await electronDeck({
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				simulatorApis: { broken: 'oops' as any },
			})
		}).rejects.toThrow(TypeError)
	})

	// ── Phase 2 contract ────────────────────────────────────────────────
	//
	// (Phase 1 "valid config rejects with not implemented" expectation was
	// removed when Phase 2 wired the actual DeckApp.)
	//
	// Phase 2 tests inject {electron, ipcMain} explicitly to skip the
	// production lazy-import path which is not driveable in vitest.

	it('Phase 2 contract: resolves for a valid empty config', async () => {
		const options = makeInjectedOptions()
		await expect(electronDeck({}, options)).resolves.toBeUndefined()
	})

	it('Phase 2 contract: invokes config.setup(runtime) once', async () => {
		const setup = vi.fn()
		await electronDeck({ setup }, makeInjectedOptions())
		expect(setup).toHaveBeenCalledTimes(1)
	})

	it('Phase 2 contract: setup throwing causes electronDeck() to reject with the same error', async () => {
		const err = new Error('user-setup-boom')
		await expect(
			electronDeck(
				{
					setup: () => {
						throw err
					},
				},
				makeInjectedOptions(),
			),
		).rejects.toBe(err)
	})
})

// ── electronDeck(config, options) — DI / lazy-import contract ──────────────

/**
 * Minimal fake Electron + ipcMain used to exercise the explicit-injection
 * branch of `electronDeck(config, options)`. Mirrors the fakes used by
 * `deck-app.test.ts` but kept local here to avoid coupling test
 * modules — these tests assert the *public entry's* DI wiring, not the
 * inner app's assembly details (which are already covered there).
 */
function createFakeIpcMain(): MinimalIpcMain & {
	handleCalls: string[]
	removeCalls: string[]
} {
	const handleCalls: string[] = []
	const removeCalls: string[] = []
	return {
		handle: (channel: string) => {
			handleCalls.push(channel)
		},
		removeHandler: (channel: string) => {
			removeCalls.push(channel)
		},
		handleCalls,
		removeCalls,
	}
}

function createFakeElectron(): MinimalElectron & {
	browserWindowCtorCount: number
	webContentsViewCtorCount: number
} {
	let browserWindowCtorCount = 0
	let webContentsViewCtorCount = 0
	let wcId = 100
	let winId = 1

	function makeWC(): MinimalWebContentsLike {
		const id = wcId++
		const destroyed = false
		return {
			id,
			isDestroyed: () => destroyed,
			loadURL: async () => undefined,
			loadFile: async () => undefined,
			send: () => undefined,
		}
	}

	class FakeBW implements MinimalBrowserWindow {
		readonly id: number
		readonly webContents: MinimalWebContentsLike
		readonly contentView: MinimalBrowserWindow['contentView']
		private destroyed = false
		constructor(_opts?: MinimalBrowserWindowOptions) {
			browserWindowCtorCount++
			this.id = winId++
			this.webContents = makeWC()
			this.contentView = { addChildView: () => undefined, removeChildView: () => undefined }
		}

		getContentBounds(): MinimalRect { return { x: 0, y: 0, width: 1024, height: 768 } }
		show(): void { /* noop */ }
		destroy(): void { this.destroyed = true }
		isDestroyed(): boolean { return this.destroyed }
		on(): this { return this }
	}

	class FakeWCV implements MinimalWebContentsView {
		readonly webContents: MinimalWebContentsLike
		constructor(_opts?: { webPreferences?: { preload?: string } }) {
			webContentsViewCtorCount++
			this.webContents = makeWC()
		}

		setBounds(): void { /* noop */ }
	}

	const electron: MinimalElectron & {
		browserWindowCtorCount: number
		webContentsViewCtorCount: number
	} = {
		BrowserWindow: FakeBW as unknown as MinimalElectron['BrowserWindow'],
		WebContentsView: FakeWCV as unknown as MinimalElectron['WebContentsView'],
		get browserWindowCtorCount() { return browserWindowCtorCount },
		get webContentsViewCtorCount() { return webContentsViewCtorCount },
	}
	return electron
}

function makeInjectedOptions(): DeckOptions {
	return {
		electron: createFakeElectron(),
		ipcMain: createFakeIpcMain(),
	}
}

describe('electronDeck(config, options) — DI', () => {
	it('with fully-injected electron + ipcMain: resolves and exercises the fake path', async () => {
		const electron = createFakeElectron()
		const ipcMain = createFakeIpcMain()
		const app: DeckConfig = {
			toolbar: {
				source: { url: 'http://localhost:9999/toolbar.html' },
				preloadPath: '/abs/preload.js',
				height: 40,
			},
		}
		await expect(electronDeck(app, { electron, ipcMain })).resolves.toBeUndefined()
		// The fake BrowserWindow ctor must have been called for the main window
		// (and the toolbar WebContentsView for the toolbar contribution).
		expect(electron.browserWindowCtorCount).toBeGreaterThanOrEqual(1)
		expect(electron.webContentsViewCtorCount).toBeGreaterThanOrEqual(1)
		// And ipcMain.handle was called by the wire transport (invoke + probe).
		expect(ipcMain.handleCalls.length).toBeGreaterThanOrEqual(2)
	})

	it('with no options at all: rejects because vitest cannot load Electron main-process module', async () => {
		// In a non-Electron environment (vitest under node), `await import("electron")`
		// resolves to the install-time entry stub (an exported path string), so the
		// real `ipcMain` / `BrowserWindow` are unavailable. The framework must reject
		// with a clear error pointing the user at `options.electron` / `options.ipcMain`.
		await expect(electronDeck({})).rejects.toThrow(/electron/i)
	})

	it('with electron injected but ipcMain missing: still rejects on lazy ipcMain lookup', async () => {
		// `options.electron` alone is not enough — framework falls through to the
		// lazy-import branch for `ipcMain`, which is undefined under vitest, so the
		// same kind of rejection fires.
		await expect(
			electronDeck({}, { electron: createFakeElectron() }),
		).rejects.toThrow(/electron|ipcMain/i)
	})
})
