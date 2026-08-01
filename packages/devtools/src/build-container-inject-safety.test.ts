/**
 * Structural guards on `build-container.js`'s injected-file transaction.
 *
 * `build-container.js` temporarily overlays devtools-owned files onto the
 * `dimina/fe` submodule before building the container, then restores the
 * submodule via `cleanupInjectedFiles()`. Driving the real script end to end
 * (populated submodule, `pnpm build`) is too heavy for a unit test, so this
 * file asserts two structural invariants directly on the source text — both
 * are real crash/corruption modes that a black-box run would not exercise
 * deterministically:
 *
 *   (a) no `process.exit(` call inside the `try { … } finally { … }` block
 *       that wraps `injectFiles()` / the build / `cleanupInjectedFiles()`.
 *       `process.exit()` terminates the process immediately — it does not
 *       unwind through a pending `finally` — so a `process.exit()` inside
 *       the `try` skips `cleanupInjectedFiles()` and leaves the submodule
 *       with devtools' overlay files still injected in place of the
 *       upstream originals.
 *
 *   (b) `injectFiles()` must refuse to silently overwrite an existing
 *       `preserveOriginalAs` backup. If a prior run crashed after copying
 *       `dest` onto `preserveOriginalAs` but before `cleanupInjectedFiles()`
 *       restored `dest`, a later run's unconditional `cpSync(dest,
 *       preserveOriginalAs)` would copy the (wrong, already-overlaid) `dest`
 *       over the correct backup, corrupting the shim's delegate target with
 *       no error raised.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUILD_CONTAINER_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'build-container.js')

function readSource(): string {
	return readFileSync(BUILD_CONTAINER_PATH, 'utf8')
}

describe('build-container.js: process.exit() never appears inside the build try/finally', () => {
	it('the try block wrapping injectFiles/build/cleanup contains no process.exit( call', () => {
		const text = readSource()
		const anchor = 'wrapped in try/finally so cleanup always runs'
		const anchorIdx = text.indexOf(anchor)
		expect(anchorIdx, 'expected to find the try/finally build-wrap doc comment').toBeGreaterThan(-1)

		const tryIdx = text.indexOf('try {', anchorIdx)
		expect(tryIdx, 'expected a `try {` following the build-wrap comment').toBeGreaterThan(-1)

		const finallyIdx = text.indexOf('} finally', tryIdx)
		expect(finallyIdx, 'expected a matching `} finally` closing the try block').toBeGreaterThan(-1)

		const tryBody = text.slice(tryIdx, finallyIdx)
		expect(
			tryBody.includes('process.exit('),
			`process.exit( appears inside the try block (before finally) — a failed build would skip cleanupInjectedFiles() and leave the submodule overlaid:\n${tryBody}`,
		).toBe(false)
	})
})

describe('build-container.js: injectFiles() refuses to clobber an existing preserveOriginalAs backup', () => {
	it('injectFiles() checks existsSync(preserveOriginalAs) and throws before overwriting it', () => {
		const text = readSource()
		const startIdx = text.indexOf('function injectFiles')
		expect(startIdx, 'expected an injectFiles() function').toBeGreaterThan(-1)
		const endIdx = text.indexOf('\nfunction cleanupInjectedFiles', startIdx)
		expect(endIdx, 'expected injectFiles() to be followed by cleanupInjectedFiles()').toBeGreaterThan(-1)
		const body = text.slice(startIdx, endIdx)

		const hasExistsCheck = /existsSync\(\s*preserveOriginalAs\s*\)/.test(body)
		expect(
			hasExistsCheck,
			`injectFiles() must check existsSync(preserveOriginalAs) before copying dest onto it:\n${body}`,
		).toBe(true)

		const hasThrowNearby = /existsSync\(\s*preserveOriginalAs\s*\)[\s\S]{0,200}throw/.test(body)
		expect(
			hasThrowNearby,
			'a preserveOriginalAs collision must throw instead of silently overwriting the existing backup',
		).toBe(true)
	})
})
