import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MiniAppContext } from './types'
import { type OpenPostDialogState, uiOverlayBus } from './ui-overlay-bus'
import { openPost } from './simulator-api-ui'

function makeCtx(): MiniAppContext {
	return {
		appId: 'test-app',
		createCallbackFunction: (fn: unknown) => fn,
	} as unknown as MiniAppContext
}

beforeEach(() => {
	uiOverlayBus.hideDialog()
})

describe('openPost', () => {
	it('pushes a dialog with kind=openPost', () => {
		const ctx = makeCtx()
		openPost.call(ctx, {})
		expect(uiOverlayBus.getState().dialog?.kind).toBe('openPost')
	})

	it('passes island metadata with defaults', () => {
		const ctx = makeCtx()
		openPost.call(ctx, {})
		const d = uiOverlayBus.getState().dialog as OpenPostDialogState
		expect(d.islandName).toBe('')
		expect(d.islandImage).toBe('')
	})

	it('passes provided island metadata', () => {
		const ctx = makeCtx()
		openPost.call(ctx, {
			islandName: 'Test Island',
			islandImage: 'https://example.com/island.png',
		})
		const d = uiOverlayBus.getState().dialog as OpenPostDialogState
		expect(d.islandName).toBe('Test Island')
		expect(d.islandImage).toBe('https://example.com/island.png')
	})

	it('does NOT fire success, fail, or complete before user interaction', () => {
		const ctx = makeCtx()
		const success = vi.fn()
		const fail = vi.fn()
		const complete = vi.fn()
		openPost.call(ctx, { success, fail, complete })
		expect(success).not.toHaveBeenCalled()
		expect(fail).not.toHaveBeenCalled()
		expect(complete).not.toHaveBeenCalled()
	})

	it('fires success with { islandId, errMsg: "openPost:ok" } on confirm', () => {
		const ctx = makeCtx()
		const success = vi.fn()
		openPost.call(ctx, { islandId: '42', success })
		const d = uiOverlayBus.getState().dialog as OpenPostDialogState
		d.onResult(true)
		expect(success).toHaveBeenCalledWith({ islandId: '42', errMsg: 'openPost:ok' })
	})

	it('fires fail with "openPost:fail cancel" on cancel', () => {
		const ctx = makeCtx()
		const fail = vi.fn()
		openPost.call(ctx, { fail })
		const d = uiOverlayBus.getState().dialog as OpenPostDialogState
		d.onResult(false)
		expect(fail).toHaveBeenCalledWith({ errMsg: 'openPost:fail cancel' })
	})

	it('does NOT fire success on cancel', () => {
		const ctx = makeCtx()
		const success = vi.fn()
		openPost.call(ctx, { success })
		const d = uiOverlayBus.getState().dialog as OpenPostDialogState
		d.onResult(false)
		expect(success).not.toHaveBeenCalled()
	})

	it('clears dialog after confirm', () => {
		const ctx = makeCtx()
		openPost.call(ctx, {})
		const d = uiOverlayBus.getState().dialog as OpenPostDialogState
		d.onResult(true)
		expect(uiOverlayBus.getState().dialog).toBeNull()
	})

	it('clears dialog after cancel', () => {
		const ctx = makeCtx()
		openPost.call(ctx, {})
		const d = uiOverlayBus.getState().dialog as OpenPostDialogState
		d.onResult(false)
		expect(uiOverlayBus.getState().dialog).toBeNull()
	})

	it('fires complete on confirm', () => {
		const ctx = makeCtx()
		const complete = vi.fn()
		openPost.call(ctx, { complete })
		const d = uiOverlayBus.getState().dialog as OpenPostDialogState
		d.onResult(true)
		expect(complete).toHaveBeenCalledTimes(1)
	})

	it('fires complete on cancel', () => {
		const ctx = makeCtx()
		const complete = vi.fn()
		openPost.call(ctx, { complete })
		const d = uiOverlayBus.getState().dialog as OpenPostDialogState
		d.onResult(false)
		expect(complete).toHaveBeenCalledTimes(1)
	})

	it('defaults islandId to empty string when not provided', () => {
		const ctx = makeCtx()
		const success = vi.fn()
		openPost.call(ctx, { success })
		const d = uiOverlayBus.getState().dialog as OpenPostDialogState
		d.onResult(true)
		expect(success).toHaveBeenCalledWith({ islandId: '', errMsg: 'openPost:ok' })
	})
})

describe('openPost — double-settle guard', () => {
	it('fires success exactly once on repeated onResult(true)', () => {
		const ctx = makeCtx()
		const success = vi.fn()
		openPost.call(ctx, { success })
		const d = uiOverlayBus.getState().dialog as OpenPostDialogState
		d.onResult(true)
		d.onResult(true)
		expect(success).toHaveBeenCalledTimes(1)
	})

	it('fires complete exactly once on repeated onResult calls', () => {
		const ctx = makeCtx()
		const complete = vi.fn()
		openPost.call(ctx, { complete })
		const d = uiOverlayBus.getState().dialog as OpenPostDialogState
		d.onResult(true)
		d.onResult(false)
		expect(complete).toHaveBeenCalledTimes(1)
	})

	it('does not fire fail when confirm is followed by cancel', () => {
		const ctx = makeCtx()
		const fail = vi.fn()
		openPost.call(ctx, { fail })
		const d = uiOverlayBus.getState().dialog as OpenPostDialogState
		d.onResult(true)
		d.onResult(false)
		expect(fail).not.toHaveBeenCalled()
	})
})
