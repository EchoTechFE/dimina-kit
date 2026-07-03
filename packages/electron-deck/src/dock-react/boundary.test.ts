/**
 * dock-react module boundary guard.
 *
 * `src/dock-react/` is the browser-consumable React renderer for the pure-TS
 * layout core. Its runtime import surface must stay exactly: `react`,
 * `react-dom`, `react/jsx-runtime`, `react-resizable-panels`, and relative
 * imports into `../layout` or same-directory (`./`) modules. Anything else —
 * `electron`, a Node built-in, or an unlisted third-party package — is a
 * dependency this directory has no business acquiring, since a pure-browser
 * project consumes it directly. The directory is scanned (not a hardcoded
 * file list) so a future split of these modules stays covered automatically.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const dockReactDir = dirname(fileURLToPath(import.meta.url))
const thisFile = fileURLToPath(import.meta.url)

const ALLOWED_BARE = new Set(['react', 'react-dom', 'react/jsx-runtime', 'react-resizable-panels'])

function isAllowed(specifier: string): boolean {
	if (ALLOWED_BARE.has(specifier)) return true
	if (specifier.startsWith('../layout')) return true
	if (specifier.startsWith('./')) return true
	return false
}

/** Recursively collect *.ts/*.tsx source files, excluding *.test.* and _-prefixed test infra. */
function collectSourceFiles(dir: string): string[] {
	const out: string[] = []
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry)
		const st = statSync(full)
		if (st.isDirectory()) {
			if (!entry.startsWith('_')) out.push(...collectSourceFiles(full))
		}
		else if (/\.tsx?$/.test(entry) && !entry.includes('.test.') && !entry.startsWith('_')) {
			out.push(full)
		}
	}
	return out
}

/** Every `from '<specifier>'` module named by a file's import/export clauses. */
function importSpecifiers(source: string): string[] {
	const specs: string[] = []
	for (const m of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
		const spec = m[1]
		if (spec !== undefined) specs.push(spec)
	}
	return specs
}

describe('dock-react module boundary (whitelisted runtime imports only)', () => {
	const files = collectSourceFiles(dockReactDir)

	it('finds at least the core source files (guard is actually scanning)', () => {
		const names = files.map(f => f.replace(dockReactDir, ''))
		expect(names.some(n => n.endsWith('index.ts'))).toBe(true)
		expect(names.some(n => n.endsWith('dock-view.tsx'))).toBe(true)
	})

	it('every source file imports only react / react-dom / react-resizable-panels / relative modules', () => {
		const offenders: string[] = []
		for (const file of files) {
			if (file === thisFile) continue
			const specs = importSpecifiers(readFileSync(file, 'utf8'))
			const bad = specs.filter(s => !isAllowed(s))
			if (bad.length > 0) offenders.push(`${file}: imports ${bad.join(', ')}`)
		}
		expect(offenders, offenders.join('\n')).toEqual([])
	})

	it('the whitelist matcher accepts allowed specifiers and rejects the rest (self-check)', () => {
		expect(isAllowed('react')).toBe(true)
		expect(isAllowed('react-dom')).toBe(true)
		expect(isAllowed('react/jsx-runtime')).toBe(true)
		expect(isAllowed('react-resizable-panels')).toBe(true)
		expect(isAllowed('../layout/index.js')).toBe(true)
		expect(isAllowed('./drag-redock.js')).toBe(true)
		expect(isAllowed('electron')).toBe(false)
		expect(isAllowed('node:fs')).toBe(false)
		expect(isAllowed('some-other-package')).toBe(false)
	})
})
