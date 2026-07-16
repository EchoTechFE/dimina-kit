import { describe, expect, it, vi } from 'vitest'
import { composeBuildCompleted, isStyleOnlyChange } from './index.js'

describe('isStyleOnlyChange', () => {
	it('returns true when every changed path is a built-in stylesheet extension', () => {
		expect(
			isStyleOnlyChange(['a.wxss', 'b.ddss', 'c.css', 'd.less', 'e.scss', 'f.sass']),
		).toBe(true)
	})

	it('returns false for an empty change set', () => {
		expect(isStyleOnlyChange([])).toBe(false)
	})

	it('returns false for a mix of style and non-style files', () => {
		expect(isStyleOnlyChange(['a.wxss', 'b.js'])).toBe(false)
	})

	it('returns false for a single non-style file', () => {
		expect(isStyleOnlyChange(['app.js'])).toBe(false)
	})

	it('accepts extra style extensions without a leading dot', () => {
		expect(isStyleOnlyChange(['page.qdss'], ['qdss'])).toBe(true)
	})

	it('accepts extra style extensions with a leading dot', () => {
		expect(isStyleOnlyChange(['page.qdss'], ['.qdss'])).toBe(true)
	})

	it('is case-insensitive on both the path extension and the extra extension', () => {
		expect(isStyleOnlyChange(['X.WXSS'])).toBe(true)
		expect(isStyleOnlyChange(['page.QDSS'], ['qdss'])).toBe(true)
	})

	it('treats a path with no extension as not style-only', () => {
		expect(isStyleOnlyChange(['Makefile'])).toBe(false)
	})

	it('only considers the extension, ignoring absolute vs relative path shape', () => {
		expect(isStyleOnlyChange(['/a/b/page.wxss'])).toBe(true)
		expect(isStyleOnlyChange(['page.js'])).toBe(false)
	})
})

describe('composeBuildCompleted', () => {
	it('when autoReload is false, calls neither reload nor reloadStyles, but still calls onRebuild', () => {
		const reload = vi.fn()
		const reloadStyles = vi.fn()
		const onRebuild = vi.fn()
		const fn = composeBuildCompleted({
			autoReload: false,
			getReload: () => reload,
			getReloadStyles: () => reloadStyles,
			onRebuild,
		})

		fn(['a.wxss'])

		expect(reload).not.toHaveBeenCalled()
		expect(reloadStyles).not.toHaveBeenCalled()
		expect(onRebuild).toHaveBeenCalledTimes(1)
	})

	it('when autoReload is true and change is style-only with reloadStyles available, hot-swaps styles only', () => {
		const reload = vi.fn()
		const reloadStyles = vi.fn()
		const fn = composeBuildCompleted({
			autoReload: true,
			getReload: () => reload,
			getReloadStyles: () => reloadStyles,
		})

		fn(['a.wxss', 'b.css'])

		expect(reloadStyles).toHaveBeenCalledTimes(1)
		expect(reload).not.toHaveBeenCalled()
	})

	it('when style-only but reloadStyles is absent, falls back to a full reload', () => {
		const reload = vi.fn()
		const fn = composeBuildCompleted({
			autoReload: true,
			getReload: () => reload,
			getReloadStyles: () => undefined,
		})

		fn(['a.wxss'])

		expect(reload).toHaveBeenCalledTimes(1)
	})

	it('when the change is not style-only, does a full reload and does not call reloadStyles', () => {
		const reload = vi.fn()
		const reloadStyles = vi.fn()
		const fn = composeBuildCompleted({
			autoReload: true,
			getReload: () => reload,
			getReloadStyles: () => reloadStyles,
		})

		fn(['a.wxss', 'b.js'])

		expect(reload).toHaveBeenCalledTimes(1)
		expect(reloadStyles).not.toHaveBeenCalled()
	})

	it('calls onRebuild on every invocation regardless of autoReload', () => {
		const onRebuild = vi.fn()
		const reload = vi.fn()

		const fnOff = composeBuildCompleted({
			autoReload: false,
			getReload: () => reload,
			onRebuild,
		})
		fnOff(['a.js'])

		const fnOn = composeBuildCompleted({
			autoReload: true,
			getReload: () => reload,
			onRebuild,
		})
		fnOn(['a.js'])

		expect(onRebuild).toHaveBeenCalledTimes(2)
	})

	it('honors custom styleExts so a project dialect file hot-swaps too', () => {
		const reload = vi.fn()
		const reloadStyles = vi.fn()
		const fn = composeBuildCompleted({
			autoReload: true,
			getReload: () => reload,
			getReloadStyles: () => reloadStyles,
			styleExts: ['qdss'],
		})

		fn(['theme.qdss'])

		expect(reloadStyles).toHaveBeenCalledTimes(1)
		expect(reload).not.toHaveBeenCalled()
	})

	it('when called with no changedPaths, treats it as empty and does a full reload', () => {
		const reload = vi.fn()
		const reloadStyles = vi.fn()
		const fn = composeBuildCompleted({
			autoReload: true,
			getReload: () => reload,
			getReloadStyles: () => reloadStyles,
		})

		fn()

		expect(reload).toHaveBeenCalledTimes(1)
		expect(reloadStyles).not.toHaveBeenCalled()
	})

	it('reads getReload/getReloadStyles at call time, not at compose time', () => {
		let currentReload = vi.fn()
		const fn = composeBuildCompleted({
			autoReload: true,
			getReload: () => currentReload,
		})

		const replacedReload = vi.fn()
		currentReload = replacedReload

		fn(['a.js'])

		expect(replacedReload).toHaveBeenCalledTimes(1)
	})
})

describe('composeBuildCompleted: onRebuild receives the style-only verdict', () => {
	it('an all-.wxss change set reports styleOnly:true with the original changedPaths', () => {
		const onRebuild = vi.fn()
		const reload = vi.fn()
		const changedPaths = ['a.wxss', 'b.wxss']
		const fn = composeBuildCompleted({
			autoReload: false,
			getReload: () => reload,
			onRebuild,
		})

		fn(changedPaths)

		expect(onRebuild.mock.calls[0]![0]).toEqual({ changedPaths, styleOnly: true })
	})

	it('a mixed .wxss + .js change set reports styleOnly:false', () => {
		const onRebuild = vi.fn()
		const reload = vi.fn()
		const fn = composeBuildCompleted({
			autoReload: false,
			getReload: () => reload,
			onRebuild,
		})

		fn(['a.wxss', 'a.js'])

		expect((onRebuild.mock.calls[0]![0] as { styleOnly: boolean }).styleOnly).toBe(false)
	})

	it('a custom styleExts-only change (e.g. .qdss) reports styleOnly:true', () => {
		const onRebuild = vi.fn()
		const reload = vi.fn()
		const fn = composeBuildCompleted({
			autoReload: false,
			getReload: () => reload,
			styleExts: ['qdss'],
			onRebuild,
		})

		fn(['theme.qdss'])

		expect((onRebuild.mock.calls[0]![0] as { styleOnly: boolean }).styleOnly).toBe(true)
	})

	it('called with no changedPaths reports styleOnly:false and an empty changedPaths array', () => {
		const onRebuild = vi.fn()
		const reload = vi.fn()
		const fn = composeBuildCompleted({
			autoReload: false,
			getReload: () => reload,
			onRebuild,
		})

		fn()

		expect(onRebuild.mock.calls[0]![0]).toEqual({ changedPaths: [], styleOnly: false })
	})
})
