/**
 * CI guard for the workbench build. Two regressions this catches:
 *
 *  1. ext-host worker inlining — under rolldown-vite the `extensionHost.worker`
 *     entry can collapse into the main chunk instead of emitting a discrete
 *     worker asset, which silently breaks the extension host (project-wide
 *     IntelliSense, contributed extensions). The `?worker&url` suffix keeps it
 *     discrete; this asserts a standalone `extensionHost.worker-*.js` exists and
 *     is substantial (the bootstrap is real code, not a stub).
 *
 *  2. SAB-gate patch missing — project-wide IntelliSense is gated on
 *     SharedArrayBuffer (not crossOriginIsolated) only after patch-ts-ext.mjs
 *     rewrites the TS extension. This asserts the patched gate is present in the
 *     built extension asset.
 *
 * Usage: node scripts/check-workbench-build.mjs [distDir]
 * Exits non-zero with a diagnostic on failure.
 */
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distDir = process.argv[2] || join(__dirname, '..', 'dist')
const assetsDir = join(distDir, 'assets')

function fail(msg) {
  console.error('[check-workbench-build] FAIL:', msg)
  process.exit(1)
}

let assets
try {
  assets = readdirSync(assetsDir)
} catch {
  fail(`assets dir not found: ${assetsDir} (run the workbench build first)`)
}

// 1. discrete ext-host worker, substantial size.
const worker = assets.find((f) => /^extensionHost\.worker-.*\.js$/.test(f))
if (!worker) {
  fail('no discrete extensionHost.worker-*.js asset — the ext-host worker got inlined (lost the ?worker&url suffix?)')
}
const workerBytes = statSync(join(assetsDir, worker)).size
if (workerBytes < 500_000) {
  fail(`extensionHost worker asset is only ${workerBytes} bytes — expected a real bootstrap (>500KB). Likely a stub.`)
}

// 2. SAB-gate patch landed in the TS extension asset.
const extAsset = assets.find((f) => /^extension-.*\.js$/.test(f) && readFileSync(join(assetsDir, f), 'utf8').includes('readWebProjectWideIntellisenseEnable'))
if (!extAsset) {
  console.warn('[check-workbench-build] note: TS language-features extension asset not found by signature; skipping SAB-gate check')
} else {
  const src = readFileSync(join(assetsDir, extAsset), 'utf8')
  if (src.includes('!!globalThis.crossOriginIsolated')) {
    fail('SAB-gate patch missing — project-wide IntelliSense still gated on crossOriginIsolated (run patch-ts-ext.mjs / prebuild)')
  }
  if (!src.includes('typeof SharedArrayBuffer')) {
    console.warn('[check-workbench-build] note: SAB-gate signature not found; the extension build may have changed — re-verify patch-ts-ext.mjs')
  }
}

console.log(`[check-workbench-build] OK — ext-host worker ${worker} (${(workerBytes / 1e6).toFixed(1)}MB), SAB-gate present`)
