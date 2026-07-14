import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MiniAppContext } from './types'
import { type ShareDialogState, uiOverlayBus } from './ui-overlay-bus'
import { share } from './simulator-api-ui'

function makeCtx(): MiniAppContext {
	return {
		appId: 'test-app',
		createCallbackFunction: (fn: unknown) => fn,
	} as unknown as MiniAppContext
}

beforeEach(() => {
	uiOverlayBus.hideDialog()
})

describe('share', () => {
	it('pushes a dialog with kind=share', () => {
		const ctx = makeCtx()
		share.call(ctx, {})
		expect(uiOverlayBus.getState().dialog?.kind).toBe('share')
	})

	it('defaults type to "link" when not specified', () => {
		const ctx = makeCtx()
		share.call(ctx, {})
		const d = uiOverlayBus.getState().dialog as ShareDialogState
		expect(d.type).toBe('link')
	})

	it('passes type="image" when specified', () => {
		const ctx = makeCtx()
		share.call(ctx, { type: 'image' })
		const d = uiOverlayBus.getState().dialog as ShareDialogState
		expect(d.type).toBe('image')
	})

	it('passes share metadata with defaults', () => {
		const ctx = makeCtx()
		share.call(ctx, {})
		const d = uiOverlayBus.getState().dialog as ShareDialogState
		expect(d.title).toBe('')
		expect(d.desc).toBe('')
		expect(d.url).toBe('')
		expect(d.cover).toBe('')
		expect(d.image).toBe('')
	})

	it('passes provided share metadata', () => {
		const ctx = makeCtx()
		share.call(ctx, {
			title: 'Check this out',
			desc: 'A cool link',
			url: 'https://example.com',
			cover: 'https://example.com/cover.png',
			image: 'https://example.com/img.png',
		})
		const d = uiOverlayBus.getState().dialog as ShareDialogState
		expect(d.title).toBe('Check this out')
		expect(d.desc).toBe('A cool link')
		expect(d.url).toBe('https://example.com')
		expect(d.cover).toBe('https://example.com/cover.png')
		expect(d.image).toBe('https://example.com/img.png')
	})

	it('does NOT fire success, fail, or complete before user interaction', () => {
		const ctx = makeCtx()
		const success = vi.fn()
		const fail = vi.fn()
		const complete = vi.fn()
		share.call(ctx, { success, fail, complete })
		expect(success).not.toHaveBeenCalled()
		expect(fail).not.toHaveBeenCalled()
		expect(complete).not.toHaveBeenCalled()
	})

	it('fires success with { errMsg: "share:ok" } on platform select', () => {
		const ctx = makeCtx()
		const success = vi.fn()
		share.call(ctx, { success })
		const d = uiOverlayBus.getState().dialog as ShareDialogState
		d.onSelect(0)
		expect(success).toHaveBeenCalledWith({ errMsg: 'share:ok' })
	})

	it('fires fail with "share:fail cancel" on cancel', () => {
		const ctx = makeCtx()
		const fail = vi.fn()
		share.call(ctx, { fail })
		const d = uiOverlayBus.getState().dialog as ShareDialogState
		d.onSelect(-1)
		expect(fail).toHaveBeenCalledWith({ errMsg: 'share:fail cancel' })
	})

	it('clears dialog after select', () => {
		const ctx = makeCtx()
		share.call(ctx, {})
		const d = uiOverlayBus.getState().dialog as ShareDialogState
		d.onSelect(0)
		expect(uiOverlayBus.getState().dialog).toBeNull()
	})

	it('clears dialog after cancel', () => {
		const ctx = makeCtx()
		share.call(ctx, {})
		const d = uiOverlayBus.getState().dialog as ShareDialogState
		d.onSelect(-1)
		expect(uiOverlayBus.getState().dialog).toBeNull()
	})

	it('fires complete on select', () => {
		const ctx = makeCtx()
		const complete = vi.fn()
		share.call(ctx, { complete })
		const d = uiOverlayBus.getState().dialog as ShareDialogState
		d.onSelect(1)
		expect(complete).toHaveBeenCalledTimes(1)
	})

	it('fires complete on cancel', () => {
		const ctx = makeCtx()
		const complete = vi.fn()
		share.call(ctx, { complete })
		const d = uiOverlayBus.getState().dialog as ShareDialogState
		d.onSelect(-1)
		expect(complete).toHaveBeenCalledTimes(1)
	})
})

describe('share — double-settle guard', () => {
	it('fires success exactly once on repeated onSelect', () => {
		const ctx = makeCtx()
		const success = vi.fn()
		share.call(ctx, { success })
		const d = uiOverlayBus.getState().dialog as ShareDialogState
		d.onSelect(0)
		d.onSelect(1)
		expect(success).toHaveBeenCalledTimes(1)
	})

	it('fires complete exactly once on repeated onSelect calls', () => {
		const ctx = makeCtx()
		const complete = vi.fn()
		share.call(ctx, { complete })
		const d = uiOverlayBus.getState().dialog as ShareDialogState
		d.onSelect(0)
		d.onSelect(-1)
		expect(complete).toHaveBeenCalledTimes(1)
	})
})
