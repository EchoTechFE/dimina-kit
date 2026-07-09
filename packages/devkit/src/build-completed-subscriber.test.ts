import { describe, expect, it, vi } from 'vitest'
import { composeBuildCompleted } from './index.js'

/**
 * Behavior tests for composeBuildCompleted.
 *
 * The contract decouples two independent user toggles that both react to a
 * finished build: live-reloading the simulator, and the caller's own
 * onRebuild bookkeeping (e.g. compile-log entries, UI badges). A developer
 * must be able to keep auto-compile ON while turning simulator auto-reload
 * OFF, so page-stack/form state survives a save. If the two were coupled,
 * disabling reload would also silence onRebuild (or vice versa).
 */

describe('composeBuildCompleted', () => {
	it('invokes reload before onRebuild when autoReload is true and a reload function is available', () => {
		const callOrder: string[] = []
		const reload = vi.fn(() => { callOrder.push('reload') })
		const getReload = vi.fn(() => reload)
		const onRebuild = vi.fn(() => { callOrder.push('onRebuild') })

		const subscriber = composeBuildCompleted({ autoReload: true, getReload, onRebuild })
		subscriber()

		expect(reload).toHaveBeenCalledTimes(1)
		expect(onRebuild).toHaveBeenCalledTimes(1)
		expect(callOrder).toEqual(['reload', 'onRebuild'])
	})

	it('does not invoke reload when autoReload is false, but still calls onRebuild', () => {
		const reload = vi.fn()
		const getReload = vi.fn(() => reload)
		const onRebuild = vi.fn()

		const subscriber = composeBuildCompleted({ autoReload: false, getReload, onRebuild })
		subscriber()

		expect(reload).not.toHaveBeenCalled()
		expect(onRebuild).toHaveBeenCalledTimes(1)
	})

	it('does not even call getReload when autoReload is false', () => {
		// Why this matters: getReload may have side effects or preconditions
		// (e.g. asserting a live webContents exists) that are only valid to
		// evaluate when a reload is actually intended.
		const getReload = vi.fn(() => vi.fn())
		const onRebuild = vi.fn()

		const subscriber = composeBuildCompleted({ autoReload: false, getReload, onRebuild })
		subscriber()

		expect(getReload).not.toHaveBeenCalled()
		expect(onRebuild).toHaveBeenCalledTimes(1)
	})

	it('does not throw when autoReload is true but getReload returns undefined, and still calls onRebuild', () => {
		// Why this matters: the simulator's reload function may not be wired up
		// yet (e.g. build finished before the webview attached). A not-ready
		// reload must not crash the build-completed pipeline.
		const getReload = vi.fn(() => undefined)
		const onRebuild = vi.fn()

		const subscriber = composeBuildCompleted({ autoReload: true, getReload, onRebuild })

		expect(() => subscriber()).not.toThrow()
		expect(getReload).toHaveBeenCalledTimes(1)
		expect(onRebuild).toHaveBeenCalledTimes(1)
	})

	it('does not throw when onRebuild is omitted, with autoReload true', () => {
		const reload = vi.fn()
		const getReload = vi.fn(() => reload)

		const subscriber = composeBuildCompleted({ autoReload: true, getReload })

		expect(() => subscriber()).not.toThrow()
		expect(reload).toHaveBeenCalledTimes(1)
	})

	it('does not throw when onRebuild is omitted, with autoReload false', () => {
		const getReload = vi.fn(() => vi.fn())

		const subscriber = composeBuildCompleted({ autoReload: false, getReload })

		expect(() => subscriber()).not.toThrow()
	})
})
