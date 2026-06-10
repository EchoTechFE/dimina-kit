#!/usr/bin/env node
/**
 * docs-api-sync CI gate. Fails fast when the host-integration docs name an
 * electron-deck API symbol that the package no longer exports.
 *
 * Background: an adversarial review caught packages/devtools/docs/workbench-model.md
 * naming `createWorkbenchClient` / `exposeWorkbenchBridge` / `__workbenchBridge`
 * while the package actually exports `createDeckClient` / `exposeDeckBridge` /
 * `__electronDeckBridge`. That kind of rename drift recurs silently, so this gate
 * extracts the API-shaped symbols the docs declare inside backticks and checks
 * each one against the *real* electron-deck export surface (every entry's
 * `export`, plus the bridge globals in shared/protocol.ts). Unknown symbols fail
 * with a drift list. Documented-but-not-exported words (devtools-side entry
 * symbols, TS built-ins, historical removed names) live in
 * scripts/docs-api-allowlist.json — adding one is an explicit, reviewable choice.
 *
 * Pure Node fs, no deps. Wired into `pnpm test` (so turbo CI runs it) — see
 * package.json. Mirrors the check-trust-seal.mjs guard pattern.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const srcRoot = join(pkgRoot, 'src')
const repoRoot = join(pkgRoot, '..', '..')

/**
 * The host-integration *API reference* docs — the ones that enumerate the
 * public export names a downstream host imports. These are what drifts against
 * the export surface (the original review caught createWorkbenchClient /
 * exposeWorkbenchBridge / __workbenchBridge here).
 *
 * Scope is deliberately narrow. packages/electron-deck/docs/*.md are
 * architecture / contract *design* specs: they name prospective types, web /
 * Electron / third-party-library symbols (ResizeObserver, WebContents, Lumino
 * BoxLayout, …) and design-doc-local record types that are not package exports.
 * Gating those on the export surface would be all noise — a different genre of
 * doc, out of scope for an API-name anti-rot gate.
 */
const DOC_FILES = [
	join(pkgRoot, 'README.md'),
	join(repoRoot, 'packages', 'devtools', 'docs', 'workbench-model.md'),
]

const ALLOWLIST_FILE = join(here, 'docs-api-allowlist.json')

/** Recursively collect *.ts files, excluding *.test.ts. */
function collectTs(dir) {
	const out = []
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry)
		const st = statSync(full)
		if (st.isDirectory()) out.push(...collectTs(full))
		else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full)
	}
	return out
}

/**
 * Real export surface: every identifier exported anywhere in src/. We harvest
 * the whole tree (not just entry files) on purpose — a symbol that is exported
 * by *some* module is a real package symbol, which is exactly what the docs are
 * allowed to name. This avoids fragile `export * from`/re-export graph walking
 * while still catching renamed/removed APIs.
 */
function realExports() {
	const names = new Set()
	for (const file of collectTs(srcRoot)) {
		const t = readFileSync(file, 'utf8')
		// export function/class/const/let/var/interface/type/enum NAME
		for (const m of t.matchAll(
			/export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
		)) {
			names.add(m[1])
		}
		// export { A, B as C, type D } [from '...']
		for (const m of t.matchAll(/export\s*(?:type\s*)?\{([^}]*)\}/g)) {
			for (const part of m[1].split(',')) {
				const seg = part.trim().replace(/^type\s+/, '')
				if (!seg) continue
				const as = seg.split(/\s+as\s+/)
				const nm = (as[1] ?? as[0]).trim()
				if (/^[A-Za-z_$][\w$]*$/.test(nm)) names.add(nm)
			}
		}
	}
	// Bridge / layout-bridge global names are declared as string literals in
	// shared/protocol.ts (the SoT), not as exported identifiers. Add their
	// runtime values so the docs may name e.g. `__electronDeckBridge`.
	const protocol = readFileSync(join(srcRoot, 'shared', 'protocol.ts'), 'utf8')
	for (const m of protocol.matchAll(
		/export\s+const\s+(?:DEFAULT_[A-Z_]*BRIDGE_GLOBAL)\s*=\s*'([^']+)'/g,
	)) {
		names.add(m[1])
	}
	return names
}

/**
 * Extract API-shaped symbols declared inside backtick code spans / fenced
 * blocks. We deliberately match only identifier *shapes* that look like
 * exported package symbols, so prose words don't masquerade as API claims:
 *   - bridge / layout globals:  __electronDeckBridge, __electronDeckLayoutBridge
 *   - factory / verb functions: createX, exposeX, defineX, validateX, isX, bindX,
 *                               unbindX, electronDeck, startElectronDeck, launch
 *   - exported PascalCase types/classes: DeckConfig, HostEvent, WireTransport, …
 * Anything matching a shape but absent from realExports ∪ allowlist is drift.
 */
function extractDocSymbols(text) {
	const spans = []
	// Pull fenced ```...``` blocks first and remove them from the text, so the
	// inline-backtick scan below can't mis-pair an inline span's backticks with a
	// fence delimiter (which would swallow `createWorkbenchClient()` on a table
	// row into a fenced region and hide it).
	const fenceStripped = text.replace(/```[\s\S]*?```/g, (block) => {
		spans.push(block)
		return '\n'
	})
	// inline `...`
	for (const m of fenceStripped.matchAll(/`([^`]+)`/g)) spans.push(m[1])

	const symbols = new Map() // name -> first matched raw context
	const VERB = /^(?:create|expose|define|validate|is|bind|unbind|start)[A-Z]/
	for (const span of spans) {
		for (const m of span.matchAll(/[A-Za-z_$][\w$]*/g)) {
			const id = m[0]
			let isApiShape = false
			if (id.startsWith('__')) isApiShape = true // a global bridge name
			else if (VERB.test(id)) isApiShape = true
			else if (id === 'electronDeck' || id === 'launch') isApiShape = true
			else if (/^[A-Z][a-z]/.test(id) && /[a-z][A-Z]/.test(id)) {
				// PascalCase with an internal lowercase->uppercase hump:
				// DeckConfig, HostEvent, WireTransport, RuntimeBackend, …
				// (excludes ALLCAPS acronyms like JSON/IPC and single-hump
				// noise like `My` via the [a-z][A-Z] requirement)
				isApiShape = true
			}
			if (isApiShape && !symbols.has(id)) symbols.set(id, span.trim().slice(0, 80))
		}
	}
	return symbols
}

const exportSurface = realExports()
const allowlist = JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8'))
const allowed = new Set(Object.keys(allowlist).filter((k) => !k.startsWith('_')))

const drift = []
for (const file of DOC_FILES) {
	let text
	try {
		text = readFileSync(file, 'utf8')
	}
	catch (err) {
		console.error(`[check-docs-api-sync] cannot read doc file: ${file}`)
		throw err
	}
	const symbols = extractDocSymbols(text)
	for (const [name, ctx] of symbols) {
		if (exportSurface.has(name) || allowed.has(name)) continue
		drift.push({ file, name, ctx })
	}
}

if (drift.length > 0) {
	console.error(
		'[check-docs-api-sync] doc names symbols that are NOT electron-deck exports.\n'
		+ 'Either fix the doc to the real export name, or — if the word is a deliberate\n'
		+ 'non-export (devtools-side symbol, TS built-in, historical name) — add it to\n'
		+ 'scripts/docs-api-allowlist.json with a justification.\n',
	)
	for (const d of drift) {
		const rel = d.file.replace(repoRoot + '/', '')
		console.error(`  ${rel}: \`${d.name}\`  (in: ${d.ctx})`)
	}
	process.exit(1)
}

console.log(
	`[check-docs-api-sync] OK — ${DOC_FILES.length} doc(s) name only real exports `
	+ `(${exportSurface.size} exports, ${allowed.size} allow-listed non-exports).`,
)
process.exit(0)
