#!/usr/bin/env node

/**
 * Bundle the two worker entry points into single self-contained ESM files.
 *
 * Hard invariant (fs-core's move-in-place contract with its consumers):
 * dist/fs-core.worker.js and dist/fs-query.worker.js must be single-file,
 * self-contained ESM with NO import statements, same filenames, same
 * directory as dist/client.js. Downstream consumers (dimina-kit workbench's
 * vite-preset.ts fsCoreWorkerAliases, the external qdmp server.cjs) resolve
 * `dirname(require.resolve('@dimina-kit/fs-core/client')) + 'fs-core.worker.js'`
 * and copy that file by its literal name — there is no import graph for them
 * to follow, so the worker's own source (now split across fs-core.worker.ts,
 * fs-core-recovery.ts, fs-core-write-ops.ts, worker-lib/*.ts — see each file's
 * header) must be bundled back into one file here.
 *
 * tsc can't do this (it emits one output file per input module); esbuild's
 * bundler inlines the whole import graph into the two outfiles below, then
 * this script asserts the no-import invariant holds before declaring success.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const ENTRIES = [
  { src: 'src/fs-core.worker.ts', outfile: 'dist/fs-core.worker.js' },
  { src: 'src/fs-query.worker.ts', outfile: 'dist/fs-query.worker.js' },
]

for (const { src, outfile } of ENTRIES) {
  const r = spawnSync(
    'npx',
    ['esbuild', src, '--bundle', '--format=esm', '--target=es2022', '--platform=browser', `--outfile=${outfile}`],
    { cwd: __dirname, stdio: 'inherit', shell: true },
  )
  if (r.status !== 0) process.exit(r.status ?? 1)
}

// worker-files.ts additionally ships as CJS (exports map `require` condition)
// so CommonJS hosts (e.g. qdmp-web-workbench's server.cjs) can consume the
// worker-artifact contract without require(esm) support.
{
  const r = spawnSync(
    'npx',
    ['esbuild', 'src/worker-files.ts', '--format=cjs', '--platform=neutral', '--target=es2022', '--outfile=dist/worker-files.cjs'],
    { cwd: __dirname, stdio: 'inherit', shell: true },
  )
  if (r.status !== 0) process.exit(r.status ?? 1)
}

// Self-check: assert both bundles are single-file, import-free ESM.
let failed = false
for (const { outfile } of ENTRIES) {
  const text = readFileSync(join(__dirname, outfile), 'utf8')
  const importLines = text.split('\n').filter((l) => /^\s*import\s/.test(l))
  if (importLines.length) {
    failed = true
    console.error(`[build-workers] ${outfile} contains import statement(s) — bundling did not fully inline the graph:`)
    for (const l of importLines) console.error('  ' + l)
  }
}
if (failed) process.exit(1)

console.log('fs-core workers bundled → dist/fs-core.worker.js, dist/fs-query.worker.js (no imports)')
