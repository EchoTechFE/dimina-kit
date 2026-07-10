import { describe, expect, it } from 'vitest'
import { WATCH_IGNORE_DIRS as indexExport } from './index.js'
import { WATCH_IGNORE_DIRS as leafExport } from './watch-ignore.js'

/**
 * Pins down WATCH_IGNORE_DIRS as the single source of truth for the directory
 * names that are NEVER mini-app source and must be skipped by every project
 * watcher — the drift-proof core shared by the devkit recompile watcher and
 * the devtools editor mirror. Deliberately minimal: build-tool output names
 * like `dist`/`build` are NOT here, because app.json may declare pages under
 * such paths and the compiler must still see edits to them (hiding build output
 * from the editor is the devtools mirror's own concern, layered on top). Both
 * the leaf module and the package index must expose the identical set object —
 * two equal-membership sets would still let the call sites drift over time.
 */

const EXPECTED_MEMBERS = [
	'node_modules',
	'.git',
	'.svn',
	'.hg',
]

describe('WATCH_IGNORE_DIRS', () => {
	it('is re-exported from index.ts as the exact same Set instance as the leaf module', () => {
		expect(indexExport).toBe(leafExport)
	})

	it.each(EXPECTED_MEMBERS)('contains %s', (member) => {
		expect(leafExport.has(member)).toBe(true)
	})

	it('contains exactly the expected members, no more and no fewer', () => {
		expect(new Set(leafExport)).toEqual(new Set(EXPECTED_MEMBERS))
	})

	it.each(['src', 'pages', 'miniprogram_npm', 'dist', 'build'])('does not contain %s', (nonMember) => {
		expect(leafExport.has(nonMember)).toBe(false)
	})
})
