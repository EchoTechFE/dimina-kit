/**
 * Contract test for `fileSystemManagerAPINames`, the export this module's
 * `base/index.js` counterpart maps into `wx.canIUse('FileSystemManager.<name>')`
 * (`fileSystemManagerAPINames.map(name => 'FileSystemManager.' + name)`, see
 * `dimina/fe/packages/service/src/api/core/base/index.js`).
 *
 * The devtools simulator only wires the 16 ASYNC `FileSystemManager` methods
 * to a working container backend (see `simulator-api-fsm.test.ts`); every
 * `*Sync` method and every file-descriptor op (open/close/read/write/fstat/
 * ftruncate + their Sync variants) has no working backend in the simulator.
 * `fileSystemManagerAPINames` must therefore be EXACTLY that 16-name async
 * set — reporting a wider name (as `Object.getOwnPropertyNames(prototype)`
 * currently does) makes `wx.canIUse` lie about capabilities the simulator
 * cannot actually provide.
 *
 * This file is injected to REPLACE the upstream `service/src/api/core/file/
 * index.js` at container build time (see its own file-level docstring), so
 * it deliberately has no external imports today. If a future fix adds an
 * import that only resolves inside the dimina build pipeline (e.g. `@/api/
 * common`), a plain `import()` in this vitest suite would fail — the test
 * below degrades to reading the module's source text and locating the
 * `fileSystemManagerAPINames` array literal instead of dynamically importing
 * it, so the contract stays checkable either way.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The full documented async FSM surface (see simulator-api-fsm.test.ts). */
const EXPECTED_ASYNC_METHODS = [
	'access', 'stat', 'readFile', 'writeFile', 'appendFile', 'copyFile',
	'rename', 'unlink', 'mkdir', 'rmdir', 'readdir', 'getFileInfo',
	'saveFile', 'getSavedFileList', 'removeSavedFile', 'truncate',
].sort()

const MODULE_URL = new URL('./index.js', import.meta.url)

/**
 * Best-effort static fallback: extract the `fileSystemManagerAPINames`
 * source text between its `export const` declaration and the next
 * top-level `let`/`export`/`function` boundary, then pull out every quoted
 * method name literal it references. This only has to be precise enough to
 * catch "the export still lists the whole sync/fd-op surface" — it does not
 * need to fully parse JS.
 */
function namesFromSourceFallback(): string[] {
	const src = readFileSync(fileURLToPath(MODULE_URL), 'utf8')
	const marker = 'fileSystemManagerAPINames'
	const idx = src.indexOf(marker)
	if (idx === -1) {
		throw new Error(`could not locate '${marker}' in ${MODULE_URL} source`)
	}
	// If the fix keeps the current derive-from-prototype shape, the literal
	// method names live in the `class FileSystemManager { ... }` body above
	// the export, not the export line itself — collect method names declared
	// there (word immediately followed by `(opts)` or `()`  at the start of a
	// line, minus `constructor`).
	const classStart = src.indexOf('class FileSystemManager')
	const classEnd = classStart === -1 ? -1 : src.indexOf('\n}', classStart)
	const body = classStart === -1 || classEnd === -1 ? src : src.slice(classStart, classEnd)
	const methodNames = new Set<string>()
	const methodPattern = /^\s*([A-Za-z_$][\w$]*)\s*\(/gm
	let m: RegExpExecArray | null
	while ((m = methodPattern.exec(body))) {
		const name = m[1]
		if (name && name !== 'constructor') methodNames.add(name)
	}
	// A hand-written array literal (`export const fileSystemManagerAPINames =
	// [...]`) instead of a derived list: also collect quoted string literals
	// following the marker up to the next top-level statement.
	const afterMarker = src.slice(idx, idx + 2000)
	const arrayLiteralMatch = afterMarker.match(/=\s*\[([\s\S]*?)\]/)
	if (arrayLiteralMatch) {
		const quoted = arrayLiteralMatch[1].match(/['"]([\w.]+)['"]/g) ?? []
		for (const q of quoted) methodNames.add(q.replace(/['"]/g, ''))
	}
	return [...methodNames]
}

describe('fileSystemManagerAPINames (drives wx.canIUse for FileSystemManager.*)', () => {
	it('exports exactly the 16 supported async FSM method names — no Sync/*, no fd ops', async () => {
		let names: string[] | undefined
		try {
			const mod = (await import('./index.js')) as { fileSystemManagerAPINames?: unknown }
			if (Array.isArray(mod.fileSystemManagerAPINames)) {
				names = mod.fileSystemManagerAPINames as string[]
			}
		} catch {
			// Fall through to the static-source fallback documented above.
			names = undefined
		}

		if (!names) {
			names = namesFromSourceFallback()
		}

		expect(
			[...names].sort(),
			`fileSystemManagerAPINames should be exactly ${JSON.stringify(EXPECTED_ASYNC_METHODS)} (got ${JSON.stringify([...names].sort())})`,
		).toEqual(EXPECTED_ASYNC_METHODS)
	})

	it('excludes every *Sync method name (sync FSM has no working simulator backend)', async () => {
		const mod = (await import('./index.js')) as { fileSystemManagerAPINames?: unknown }
		const names = Array.isArray(mod.fileSystemManagerAPINames) ? (mod.fileSystemManagerAPINames as string[]) : namesFromSourceFallback()
		const syncNames = names.filter(n => n.endsWith('Sync'))
		expect(syncNames, `no *Sync name should be canIUse-advertised (found ${JSON.stringify(syncNames)})`).toEqual([])
	})
})
