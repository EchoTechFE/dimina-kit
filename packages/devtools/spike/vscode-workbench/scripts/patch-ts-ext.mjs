/**
 * Gate the TS web extension's project-wide IntelliSense on SharedArrayBuffer
 * availability instead of crossOriginIsolated.
 *
 * The @vscode/typescript-language-features web extension only enables
 * project-wide IntelliSense (cross-file resolution, jsconfig discovery, ambient
 * .d.ts) when `globalThis.crossOriginIsolated` is true. Electron cannot flip
 * that boolean (it stays false even with COOP/COEP headers — electron#35905),
 * yet it CAN provide SharedArrayBuffer via the
 * `--enable-features=SharedArrayBuffer` switch, and the SAB + Atomics machinery
 * project-wide IntelliSense relies on works across workers regardless of the
 * crossOriginIsolated boolean (verified: SAB transfers via postMessage and
 * Atomics round-trips between workers with crossOriginIsolated=false).
 *
 * So the real dependency is SharedArrayBuffer, not the crossOriginIsolated
 * proxy. This rewrites the gate to check SAB directly. Idempotent: a no-op once
 * applied.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// Resolve the extension asset through Node's module resolver rather than a fixed
// relative depth: the package lives in devtools' node_modules (deps are hoisted
// to the devtools package), and exact hoisting depth is not stable across
// installs.
const require = createRequire(import.meta.url)
const pkg = require.resolve(
  '@codingame/monaco-vscode-typescript-language-features-default-extension/package.json',
)
const EXT = join(dirname(pkg), 'resources', 'extension.js')

const FROM = 'function Vn(){return pt()&&!!globalThis.crossOriginIsolated}'
const TO = 'function Vn(){return pt()&&(typeof SharedArrayBuffer!=="undefined")}'

const src = readFileSync(EXT, 'utf8')
if (src.includes(TO)) {
  console.log('[patch-ts-ext] already patched (SAB gate present) — no-op')
  process.exit(0)
}
if (!src.includes(FROM)) {
  console.error('[patch-ts-ext] ERROR: neither original nor patched gate found.')
  console.error('[patch-ts-ext] The extension build changed; re-derive the Vn() gate.')
  process.exit(1)
}
writeFileSync(EXT, src.split(FROM).join(TO))
console.log('[patch-ts-ext] patched project-wide IntelliSense gate → SharedArrayBuffer')
