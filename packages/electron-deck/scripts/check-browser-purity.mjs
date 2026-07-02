#!/usr/bin/env node
/**
 * Browser-purity CI gate. A pure-web project consumes this package via the
 * `./layout` + `./dock-react` entries (whose only same-package dependency is
 * `./client` + `src/shared`); none of the four ever runs inside Electron. This
 * guard scans their non-test source and exits 1 if any file re-introduces a
 * runtime dependency on `electron` or a Node built-in:
 *   - `from 'electron'` / `from "electron"`
 *   - `from 'node:...'` / `from "node:..."`
 *   - `require('electron')`, `import('electron')` (and the `node:` equivalents)
 * `import type` / `export type` clauses are exempt — they erase at compile
 * time and never reach the browser bundle (see src/layout/placement-reconcile.ts,
 * which legally `import type`s from `@dimina-kit/view-anchor`).
 * Pure Node fs, no deps. Mirrors the check-trust-seal.mjs guard pattern.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = join(here, '..', 'src')
const SCAN_DIRS = ['layout', 'dock-react', 'client', 'shared']

/** Recursively collect *.ts/*.tsx files, excluding *.test.* and _-prefixed test infra. */
function collect(dir) {
	const out = []
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry)
		const st = statSync(full)
		if (st.isDirectory()) {
			if (!entry.startsWith('_')) out.push(...collect(full))
		}
		else if (/\.tsx?$/.test(entry) && !entry.includes('.test.') && !entry.startsWith('_')) {
			out.push(full)
		}
	}
	return out
}

const FORBIDDEN_FROM = /from\s+['"](electron|node:[^'"]+)['"]/
const FORBIDDEN_BARE_OR_CALL = /(?:^|\s)import\s+['"](electron|node:[^'"]+)['"]|(?:require|import)\(\s*['"](electron|node:[^'"]+)['"]\s*\)/

const offenders = []
for (const dir of SCAN_DIRS) {
	for (const file of collect(join(srcRoot, dir))) {
		const lines = readFileSync(file, 'utf8').split('\n')
		lines.forEach((line, i) => {
			if (FORBIDDEN_FROM.test(line)) {
				// `import type { X } from 'electron'` erases at compile time — allowed.
				if (/^\s*(?:import|export)\s+type\b/.test(line)) return
				offenders.push(`${file}:${i + 1}: ${line.trim()}`)
				return
			}
			if (FORBIDDEN_BARE_OR_CALL.test(line)) {
				offenders.push(`${file}:${i + 1}: ${line.trim()}`)
			}
		})
	}
}

if (offenders.length > 0) {
	console.error('[check-browser-purity] browser-consumed surface (layout/dock-react/client/shared) imports electron/node at runtime:')
	for (const o of offenders) console.error('  ' + o)
	process.exit(1)
}

console.log('[check-browser-purity] OK — layout/dock-react/client/shared stay pure for browser consumption.')
process.exit(0)
