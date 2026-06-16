/**
 * GAP #5 — module boundary guard.
 *
 * Every file under `src/layout/` must be PURE TS: zero import of electron /
 * react / react-dom. This test currently PASSES (the stubs import nothing
 * forbidden) and must keep passing through implementation.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const layoutDir = dirname(fileURLToPath(import.meta.url))

function collectTsFiles(dir: string): string[] {
	const out: string[] = []
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) {
			out.push(...collectTsFiles(full))
		}
		else if (entry.endsWith('.ts')) {
			out.push(full)
		}
	}
	return out
}

// Matches: from 'electron' | from "react-dom" | require('react') | import('electron')
// for the forbidden module set, with optional subpath (e.g. 'react/jsx-runtime').
const FORBIDDEN = ['electron', 'react', 'react-dom']

function importsForbidden(source: string): string[] {
	const hits: string[] = []
	for (const mod of FORBIDDEN) {
		const escaped = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		// from '<mod>' or from '<mod>/...'  AND  require('<mod>') / import('<mod>')
		const fromRe = new RegExp(`from\\s+['"]${escaped}(?:/[^'"]*)?['"]`)
		const callRe = new RegExp(`(?:require|import)\\s*\\(\\s*['"]${escaped}(?:/[^'"]*)?['"]`)
		if (fromRe.test(source) || callRe.test(source)) hits.push(mod)
	}
	return hits
}

describe('layout module boundary (zero electron/react import)', () => {
	const files = collectTsFiles(layoutDir)

	it('finds at least the core source files (guard is actually scanning)', () => {
		const names = files.map(f => f.replace(layoutDir, ''))
		expect(names.some(n => n.endsWith('index.ts'))).toBe(true)
		expect(names.some(n => n.endsWith('types.ts'))).toBe(true)
	})

	it('no file imports electron, react, or react-dom', () => {
		const offenders: string[] = []
		for (const file of files) {
			// Skip THIS guard file: it contains the forbidden module names as data.
			if (file === fileURLToPath(import.meta.url)) continue
			const src = readFileSync(file, 'utf8')
			const bad = importsForbidden(src)
			if (bad.length > 0) {
				offenders.push(`${file}: imports ${bad.join(', ')}`)
			}
		}
		expect(offenders, offenders.join('\n')).toEqual([])
	})

	it('regex catches the forbidden patterns (self-check of the matcher)', () => {
		expect(importsForbidden(`import { app } from 'electron'`)).toContain('electron')
		expect(importsForbidden(`import React from "react"`)).toContain('react')
		expect(importsForbidden(`const x = require('react-dom')`)).toContain('react-dom')
		expect(importsForbidden(`import x from 'react/jsx-runtime'`)).toContain('react')
		expect(importsForbidden(`import { foo } from './types.js'`)).toEqual([])
		// must not false-positive on a substring like "electron-deck" host package
		expect(importsForbidden(`import { x } from '@dimina-kit/electron-deck'`)).toEqual([])
	})
})
