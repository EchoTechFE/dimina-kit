// Guards the declarations shipped alongside the bundles: every published subpath
// must carry a `types` condition that resolves to a real file, and the consumer
// fixture must still type-check against them. Run after `build:types`.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const pkgRoot = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const pkg = require('../package.json')

const failures = []

for (const [subpath, target] of Object.entries(pkg.exports)) {
  if (subpath === './package.json') continue
  if (typeof target === 'string' || !target.types) {
    failures.push(`exports["${subpath}"] ships no "types" condition — consumers get an untyped import`)
    continue
  }
  const typesFile = path.join(pkgRoot, target.types)
  if (!existsSync(typesFile)) {
    failures.push(`exports["${subpath}"].types points at ${target.types}, which does not exist`)
  }
}

if (failures.length > 0) {
  console.error(failures.map(f => `  - ${f}`).join('\n'))
  process.exit(1)
}

const tscBin = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc')
const fixture = path.join(pkgRoot, 'types-fixture', 'tsconfig.json')
const tsc = spawnSync(process.execPath, [tscBin, '-p', fixture, '--pretty', 'false'], {
  cwd: pkgRoot,
  encoding: 'utf8',
})

if (tsc.status !== 0) {
  console.error(tsc.stdout || '')
  console.error(tsc.stderr || '')
  console.error(`consumer fixture failed to type-check against the published declarations (tsc exit ${tsc.status})`)
  process.exit(1)
}

console.log(`types ok: ${Object.keys(pkg.exports).length - 1} typed subpaths, consumer fixture type-checks`)
