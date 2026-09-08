// Wraps `tsc -p tsconfig.types.json` because that config's rootDir has to
// cover both packages/compiler/src AND the dimina/fe submodule source it
// imports by relative path (see the comment in tsconfig.types.json) — so tsc
// necessarily also emits declarations for the submodule branch into the
// scratch outDir. This script keeps only the packages/compiler/src branch,
// flattened to the same dist/types/<name>.d.ts layout package.json's
// `exports[*].types` already points at, and discards the rest.
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const pkgRoot = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const rawDir = path.join(pkgRoot, 'dist/types/.raw')
const kitRawDir = path.join(rawDir, 'packages/compiler/src')
const outDir = path.join(pkgRoot, 'dist/types')

rmSync(rawDir, { recursive: true, force: true })

const tscBin = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc')
const tsc = spawnSync(process.execPath, [tscBin, '-p', 'tsconfig.types.json', '--pretty', 'false'], {
  cwd: pkgRoot,
  encoding: 'utf8',
})
if (tsc.status !== 0) {
  console.error(tsc.stdout || '')
  console.error(tsc.stderr || '')
  process.exit(tsc.status ?? 1)
}

if (!existsSync(kitRawDir)) {
  console.error(`build-types: expected tsc output at ${path.relative(pkgRoot, kitRawDir)}, found nothing`)
  process.exit(1)
}
cpSync(kitRawDir, outDir, { recursive: true })
rmSync(rawDir, { recursive: true, force: true })
