#!/usr/bin/env node
/**
 * Trust-seal CI gate (P2). Fails fast if a raw trust writer is re-introduced.
 *
 * The sealed trust model has exactly ONE writer — `admit(wc, owner)` — so a
 * `Scope` always owns every trust lease (no un-owned / leaked lease). This guard
 * scans the package's non-test source and exits 1 if any line re-introduces the
 * removed imperative writers:
 *   - `.deleteEntry(`   (the old imperative entry wipe)
 *   - `trustSet.add(`   (the old un-owned lease minting)
 * Pure Node fs, no deps.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = join(here, '..', 'src')

/** Recursively collect *.ts files, excluding *.test.ts. */
function collect(dir) {
	const out = []
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry)
		const st = statSync(full)
		if (st.isDirectory()) {
			out.push(...collect(full))
		}
		else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
			out.push(full)
		}
	}
	return out
}

const offenders = []
for (const file of collect(srcRoot)) {
	const lines = readFileSync(file, 'utf8').split('\n')
	lines.forEach((line, i) => {
		if (/\.deleteEntry\(/.test(line) || /trustSet\.add\(/.test(line)) {
			offenders.push(`${file}:${i + 1}: ${line.trim()}`)
		}
	})
}

if (offenders.length > 0) {
	console.error('[check-trust-seal] raw trust writer re-introduced (use admit(wc, owner)):')
	for (const o of offenders) console.error('  ' + o)
	process.exit(1)
}

console.log('[check-trust-seal] OK — trust writer is sealed (admit only).')
process.exit(0)
