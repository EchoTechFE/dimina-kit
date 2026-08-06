import { describe, expect, it, vi } from 'vitest'
import { reportRebuildStatus } from './rebuild-status.js'

/**
 * Contract: `reportRebuildStatus` gains `info.explicit`. An explicit rebuild
 * (the popover "重新编译" button, via `session.rebuild()`) is a hard re-attach
 * on the renderer side — it must never also fire the watcher's hot-reload
 * signal, and it must never take the style-only fast-swap path either: both
 * are soft-update paths meant for a background save, and layering a soft
 * update underneath an explicit hard re-attach would let the two race
 * against each other (the DeviceShell tearing down while a style swap or
 * webview.reload() is still in flight).
 *
 * `explicit: true` must always resolve to `sendStatus('ready', <message>,
 * <falsy>, pages)` and must never call `deps.refreshSimulatorStyles`,
 * regardless of `autoReload` / `styleOnly`. When `explicit` is absent or
 * false, behavior is byte-identical to before this contract (the style
 * fast-path and the `hotReload: autoReload` full-reload path).
 */

type Info = Parameters<typeof reportRebuildStatus>[0]

/**
 * `explicit` is not yet part of the `reportRebuildStatus` info type — routed
 * through a variable (not an inline object literal) so this exercises the
 * RUNTIME contract instead of tripping TypeScript's excess-property check on
 * a not-yet-declared field.
 */
function makeInfo(overrides: { styleOnly?: boolean, explicit?: boolean }): Info {
	const info = { ...overrides }
	return info as Info
}

function makeDeps(overrides: { autoReload: boolean, refreshSimulatorStylesReturns?: boolean }) {
	const sendStatus = vi.fn()
	const refreshSimulatorStyles = vi.fn(() => overrides.refreshSimulatorStylesReturns ?? true)
	const getProjectPages = vi.fn(() => ({ pages: ['pages/index/index'] }))
	return {
		projectPath: '/tmp/explicit-rebuild-project',
		repo: { getProjectPages },
		autoReload: overrides.autoReload,
		refreshSimulatorStyles,
		sendStatus,
	}
}

describe('reportRebuildStatus: an explicit rebuild never triggers a soft hot-reload path', () => {
	it('explicit:true + autoReload:true + styleOnly:true does NOT take the style-swap fast path', () => {
		const deps = makeDeps({ autoReload: true })

		reportRebuildStatus(makeInfo({ styleOnly: true, explicit: true }), deps)

		expect(
			deps.refreshSimulatorStyles,
			'an explicit rebuild must hard re-attach, not hot-swap stylesheets in place — refreshSimulatorStyles is the soft-update path',
		).not.toHaveBeenCalled()
	})

	it('explicit:true + autoReload:true + styleOnly:true reports a falsy hotReload flag', () => {
		const deps = makeDeps({ autoReload: true })

		reportRebuildStatus(makeInfo({ styleOnly: true, explicit: true }), deps)

		expect(deps.sendStatus).toHaveBeenCalledTimes(1)
		const hotReloadArg = deps.sendStatus.mock.calls[0]![2]
		expect(
			hotReloadArg,
			'an explicit rebuild must not also bump the renderer hot-reload token — the popover already drives its own hard re-attach',
		).toBeFalsy()
	})

	it('explicit:true + autoReload:true + styleOnly:false reports a falsy hotReload flag (not the usual autoReload-driven true)', () => {
		const deps = makeDeps({ autoReload: true })

		reportRebuildStatus(makeInfo({ styleOnly: false, explicit: true }), deps)

		const hotReloadArg = deps.sendStatus.mock.calls[0]![2]
		expect(
			hotReloadArg,
			'without the explicit override this combination normally reports hotReload: true — an explicit rebuild must suppress it',
		).toBeFalsy()
	})

	it('explicit:true + autoReload:false reports status ready with a falsy hotReload flag', () => {
		const deps = makeDeps({ autoReload: false })

		reportRebuildStatus(makeInfo({ styleOnly: false, explicit: true }), deps)

		expect(deps.sendStatus).toHaveBeenCalledTimes(1)
		const call = deps.sendStatus.mock.calls[0]!
		expect(call[0]).toBe('ready')
		expect(call[2], 'an explicit rebuild must report a falsy hotReload flag even with autoReload off').toBeFalsy()
		expect(call[3]).toEqual(['pages/index/index'])
	})

	it('explicit:true never calls refreshSimulatorStyles even when it would succeed and autoReload is on', () => {
		const deps = makeDeps({ autoReload: true, refreshSimulatorStylesReturns: true })

		reportRebuildStatus(makeInfo({ styleOnly: true, explicit: true }), deps)

		expect(deps.refreshSimulatorStyles).not.toHaveBeenCalled()
	})
})

describe('reportRebuildStatus: explicit absent/false preserves the pre-existing watcher-rebuild behavior', () => {
	it('explicit:false + autoReload:true + styleOnly:true still takes the style-swap fast path (unchanged)', () => {
		const deps = makeDeps({ autoReload: true, refreshSimulatorStylesReturns: true })

		reportRebuildStatus(makeInfo({ styleOnly: true, explicit: false }), deps)

		expect(deps.refreshSimulatorStyles).toHaveBeenCalledTimes(1)
		expect(deps.sendStatus).toHaveBeenCalledWith('ready', '样式已热更新', false, ['pages/index/index'])
	})

	it('explicit undefined + autoReload:true + styleOnly:false still reports hotReload:true (unchanged)', () => {
		const deps = makeDeps({ autoReload: true })

		reportRebuildStatus(makeInfo({ styleOnly: false }), deps)

		expect(deps.sendStatus).toHaveBeenCalledWith('ready', '编译完成，已重启', true, ['pages/index/index'])
	})
})
