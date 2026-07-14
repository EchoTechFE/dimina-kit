import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MiniAppContext } from './types'
import { type HalfSheetDialogState, uiOverlayBus } from './ui-overlay-bus'
import { joinIsland } from './simulator-api-ui'

function makeCtx(): MiniAppContext {
	return {
		appId: 'test-app',
		createCallbackFunction: (fn: unknown) => fn,
	} as unknown as MiniAppContext
}

beforeEach(() => {
	uiOverlayBus.hideDialog()
})

describe('joinIsland', () => {
	it('pushes a dialog with kind=halfSheet', () => {
		const ctx = makeCtx()
		joinIsland.call(ctx, {})
		expect(uiOverlayBus.getState().dialog?.kind).toBe('halfSheet')
	})

	it('passes island metadata with defaults', () => {
		const ctx = makeCtx()
		joinIsland.call(ctx, {})
		const d = uiOverlayBus.getState().dialog as HalfSheetDialogState
		expect(d.islandName).toBe('Mock Island')
		expect(d.islandAvatar).toBe('')
		expect(d.memberCount).toBe('128')
	})

	it('passes provided island metadata', () => {
		const ctx = makeCtx()
		joinIsland.call(ctx, {
			islandName: 'Test Island',
			islandAvatar: 'https://example.com/avatar.png',
			memberCount: '42',
		})
		const d = uiOverlayBus.getState().dialog as HalfSheetDialogState
		expect(d.islandName).toBe('Test Island')
		expect(d.islandAvatar).toBe('https://example.com/avatar.png')
		expect(d.memberCount).toBe('42')
	})

	it('does NOT fire success, fail, or complete before user interaction', () => {
		const ctx = makeCtx()
		const success = vi.fn()
		const fail = vi.fn()
		const complete = vi.fn()
		joinIsland.call(ctx, { success, fail, complete })
		expect(success).not.toHaveBeenCalled()
		expect(fail).not.toHaveBeenCalled()
		expect(complete).not.toHaveBeenCalled()
	})

	it('fires success with { errMsg: "joinIsland:ok" } on confirm', () => {
		const ctx = makeCtx()
		const success = vi.fn()
		joinIsland.call(ctx, { success })
		const d = uiOverlayBus.getState().dialog as HalfSheetDialogState
		d.onResult(true)
		expect(success).toHaveBeenCalledWith({ errMsg: 'joinIsland:ok' })
	})

	it('fires fail with "joinIsland:fail cancel" on cancel', () => {
		const ctx = makeCtx()
		const fail = vi.fn()
		joinIsland.call(ctx, { fail })
		const d = uiOverlayBus.getState().dialog as HalfSheetDialogState
		d.onResult(false)
		expect(fail).toHaveBeenCalledWith({ errMsg: 'joinIsland:fail cancel' })
	})

	it('does NOT fire success on cancel', () => {
		const ctx = makeCtx()
		const success = vi.fn()
		joinIsland.call(ctx, { success })
		const d = uiOverlayBus.getState().dialog as HalfSheetDialogState
		d.onResult(false)
		expect(success).not.toHaveBeenCalled()
	})

	it('fires complete on confirm', () => {
		const ctx = makeCtx()
		const complete = vi.fn()
		joinIsland.call(ctx, { complete })
		const d = uiOverlayBus.getState().dialog as HalfSheetDialogState
		d.onResult(true)
		expect(complete).toHaveBeenCalledTimes(1)
	})

	it('fires complete on cancel', () => {
		const ctx = makeCtx()
		const complete = vi.fn()
		joinIsland.call(ctx, { complete })
		const d = uiOverlayBus.getState().dialog as HalfSheetDialogState
		d.onResult(false)
		expect(complete).toHaveBeenCalledTimes(1)
	})

	it('clears dialog to null after confirm', () => {
		const ctx = makeCtx()
		joinIsland.call(ctx, {})
		const d = uiOverlayBus.getState().dialog as HalfSheetDialogState
		d.onResult(true)
		expect(uiOverlayBus.getState().dialog).toBeNull()
	})

	it('clears dialog to null after cancel', () => {
		const ctx = makeCtx()
		joinIsland.call(ctx, {})
		const d = uiOverlayBus.getState().dialog as HalfSheetDialogState
		d.onResult(false)
		expect(uiOverlayBus.getState().dialog).toBeNull()
	})
})

describe('joinIsland — double-settle guard', () => {
	it('fires success exactly once on repeated onResult(true)', () => {
		const ctx = makeCtx()
		const success = vi.fn()
		joinIsland.call(ctx, { success })
		const d = uiOverlayBus.getState().dialog as HalfSheetDialogState
		d.onResult(true)
		d.onResult(true)
		expect(success).toHaveBeenCalledTimes(1)
	})

	it('fires complete exactly once on repeated onResult calls', () => {
		const ctx = makeCtx()
		const complete = vi.fn()
		joinIsland.call(ctx, { complete })
		const d = uiOverlayBus.getState().dialog as HalfSheetDialogState
		d.onResult(true)
		d.onResult(false)
		expect(complete).toHaveBeenCalledTimes(1)
	})

	it('does not fire fail when confirm is followed by cancel', () => {
		const ctx = makeCtx()
		const fail = vi.fn()
		joinIsland.call(ctx, { fail })
		const d = uiOverlayBus.getState().dialog as HalfSheetDialogState
		d.onResult(true)
		d.onResult(false)
		expect(fail).not.toHaveBeenCalled()
	})
})
