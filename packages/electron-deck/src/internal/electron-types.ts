/**
 * Phase 4 — minimal structural typing for the Electron surface the electron-deck
 * framework needs to assemble its real windows / views. Tests inject a plain
 * object satisfying these shapes via {@link DeckAppOptions.electron};
 * the framework does **not** import 'electron' directly.
 *
 * Mirror of {@link wire-transport.ts}'s `MinimalIpcMain` / `MinimalWebContents`
 * style — narrow enough to express the contract, wide enough for tests to fake
 * with `vi.fn()`.
 *
 * @internal
 */

export interface MinimalRect {
	x: number
	y: number
	width: number
	height: number
}

export interface MinimalBrowserWindowOptions {
	width?: number
	height?: number
	minWidth?: number
	minHeight?: number
	title?: string
	icon?: string
	modal?: boolean
	show?: boolean
	backgroundColor?: string
	parent?: MinimalBrowserWindow
	/**
	 * Carries the merged window prefs (framework defaults + `config.app.window`
	 * + backend `mainWindowWebPreferences()`); `preload` is the one key the
	 * framework itself sets for declared/toolbar webviews.
	 */
	webPreferences?: Record<string, unknown> & { preload?: string }
}

export interface MinimalWebContentsLike {
	readonly id: number
	loadURL(url: string): Promise<void>
	loadFile(path: string): Promise<void>
	send(channel: string, payload: unknown): void
	/**
	 * Destroy the backing renderer (Electron's `webContents.close()`). Guard with
	 * `isDestroyed()` for idempotence — never double-close. Optional so legacy fakes
	 * that never need it keep compiling; the real Electron `webContents` always has it.
	 * Typed as `Function` (not `() => void`) on purpose: test fakes assign a bare
	 * `vi.fn()` Mock whose `Mock<Procedure | Constructable>` carries a construct
	 * signature that is not assignable to a plain call signature — only `Function`
	 * (or `unknown`) accepts it. Callers invoke it as `close?.()`.
	 */
	// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
	close?: Function
	isDestroyed(): boolean
}

export interface MinimalContentView {
	addChildView(view: MinimalWebContentsView): void
	removeChildView(view: MinimalWebContentsView): void
	/** The window's live child views (real Electron `View.children`). Used by the
	 *  moveTo rollback to guard against removing a child the dest never added
	 *  (codex P0 round-3 BUG 2). Optional so existing fakes stay valid; an absent
	 *  array is treated as "membership unknown" by the guard's `?? []`. */
	readonly children?: readonly MinimalWebContentsView[]
}

export interface MinimalBrowserWindow {
	readonly id: number
	readonly webContents: MinimalWebContentsLike
	readonly contentView: MinimalContentView
	getContentBounds(): MinimalRect
	show(): void
	destroy(): void
	isDestroyed(): boolean
	/** `close` is cancelable (preventDefault); `resize`/`closed` listeners ignore the arg. */
	on(
		event: 'resize' | 'closed' | 'close',
		listener: (e?: { preventDefault(): void }) => void,
	): MinimalBrowserWindow
	/**
	 * Register a listener at the FRONT of the listener list (Electron's
	 * EventEmitter `prependListener` — prepended listeners run BEFORE any earlier
	 * `on`-added listener for the same event). The framework uses this to arm an
	 * adopted window's trust/grant revocation so it runs FIRST on `'closed'`,
	 * before any external `'closed'` listener the host registered earlier.
	 *
	 * Optional so legacy fakes that never adopt a window keep compiling without it;
	 * the real Electron `BrowserWindow` (an EventEmitter) always provides it, and
	 * `runtime.windows.adopt` requires it at runtime. Typed as a bare `Function`
	 * (like `close`) so a test fake can assign a plain `vi.fn()` Mock — whose
	 * `Mock<Procedure | Constructable>` carries a construct signature that a strict
	 * call signature rejects. Callers invoke it as `win.prependListener('closed', fn)`.
	 */
	// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
	prependListener?: Function
}

export interface MinimalWebContentsView {
	readonly webContents: MinimalWebContentsLike
	setBounds(rect: MinimalRect): void
}

/**
 * Minimal `app` surface the framework needs to own the Electron process
 * lifecycle as the sole orchestrator. Only methods the framework calls on the
 * host's behalf belong here — host-specific app APIs (dock, getPath, …) go
 * through `runtime.electron.app`. Injected via {@link MinimalElectron.app};
 * the framework never `import`s 'electron'.
 */
export interface MinimalApp {
	/** Gating: the framework must `await` this before constructing any window. */
	whenReady(): Promise<void>
	/** Pre-ready: set the default app/dock name (best-effort). */
	setName(name: string): void
	/** Process lifecycle: drives shutdown / quit-on-all-closed. */
	on(
		event: 'will-quit' | 'before-quit' | 'window-all-closed' | 'second-instance',
		listener: (e?: { preventDefault(): void }) => void,
	): MinimalApp
	quit(): void
	/** Opt-in single-instance; only called when `config.app.singleInstance`. */
	requestSingleInstanceLock?(): boolean
}

export interface MinimalElectron {
	readonly BrowserWindow: new (opts?: MinimalBrowserWindowOptions) => MinimalBrowserWindow
	readonly WebContentsView: new (opts?: { webPreferences?: { preload?: string } }) => MinimalWebContentsView
	/**
	 * Optional `app` surface. Present on the production path (lazy-imported real
	 * electron) and when tests exercise the whenReady gate; absent in legacy
	 * fakes that only assemble windows — the gate is then skipped (back-compat).
	 */
	readonly app?: MinimalApp
}
