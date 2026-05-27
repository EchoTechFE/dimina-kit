/**
 * Phase 4 — minimal structural typing for the Electron surface the workbench
 * framework needs to assemble its real windows / views. Tests inject a plain
 * object satisfying these shapes via {@link WorkbenchAppOptions.electron};
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
	parent?: MinimalBrowserWindow
	webPreferences?: { preload?: string }
}

export interface MinimalWebContentsLike {
	readonly id: number
	loadURL(url: string): Promise<void>
	loadFile(path: string): Promise<void>
	send(channel: string, payload: unknown): void
	isDestroyed(): boolean
}

export interface MinimalContentView {
	addChildView(view: MinimalWebContentsView): void
	removeChildView(view: MinimalWebContentsView): void
}

export interface MinimalBrowserWindow {
	readonly id: number
	readonly webContents: MinimalWebContentsLike
	readonly contentView: MinimalContentView
	getContentBounds(): MinimalRect
	show(): void
	destroy(): void
	isDestroyed(): boolean
	on(event: 'resize' | 'closed', listener: () => void): MinimalBrowserWindow
}

export interface MinimalWebContentsView {
	readonly webContents: MinimalWebContentsLike
	setBounds(rect: MinimalRect): void
}

export interface MinimalElectron {
	readonly BrowserWindow: new (opts?: MinimalBrowserWindowOptions) => MinimalBrowserWindow
	readonly WebContentsView: new (opts?: { webPreferences?: { preload?: string } }) => MinimalWebContentsView
}
