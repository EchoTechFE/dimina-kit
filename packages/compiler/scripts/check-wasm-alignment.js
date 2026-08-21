import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { resolveInstalledVersion } from './resolve-installed-version.js'

function printUsage() {
  console.log(
    'Usage: node scripts/check-wasm-alignment.js\n\n' +
      'Fails if packages/compiler resolves any shared dependency to a version that\n' +
      'differs from upstream-lockfile-snapshot.json — a frozen record of what upstream\n' +
      '@dimina/compiler (dimina submodule) resolved at the commit the snapshot was taken\n' +
      'at — or if the submodule has since moved to a different commit than the snapshot\n' +
      'records. Also checks the wasm/native build pairs\n' +
      'oxc-parser/@oxc-parser/binding-wasm32-wasi and esbuild/esbuild-wasm.\n' +
      'Requires packages/compiler to be installed (pnpm install); does not need\n' +
      "dimina/fe's own workspace installed. Run scripts/snapshot-upstream-versions.js to\n" +
      'refresh the snapshot after bumping the dimina submodule pointer or upgrading a\n' +
      'packages/compiler dependency upstream also shares.',
  )
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  printUsage()
  process.exit(0)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const kitPkgPath = path.join(root, 'package.json')
const diminaRoot = path.resolve(root, '../../dimina')
const snapshotPath = path.join(root, 'upstream-lockfile-snapshot.json')

async function readJson(p) {
  return JSON.parse(await readFile(p, 'utf8'))
}

const kitPkg = await readJson(kitPkgPath)

let snapshot
try {
  snapshot = await readJson(snapshotPath)
} catch (err) {
  console.error(
    `check-wasm-alignment: could not read ${snapshotPath} (${err.message})\n` +
      'Run: node scripts/snapshot-upstream-versions.js',
  )
  process.exit(2)
}

let diminaCommit
try {
  diminaCommit = execFileSync('git', ['-C', diminaRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
} catch (err) {
  console.error(
    `check-wasm-alignment: could not read dimina submodule HEAD (${err.message})\n` +
      'Run: git submodule update --init dimina',
  )
  process.exit(2)
}

// The snapshot is only valid for the exact submodule commit it was taken at:
// upstream's own package.json (and therefore which deps it resolves) can
// change between commits. A pointer bump that doesn't come with a refreshed
// snapshot is a stale-data problem, not a real version mismatch — surface it
// as its own failure so it isn't confused with an actual drift.
if (diminaCommit !== snapshot.diminaCommit) {
  console.error(
    `check-wasm-alignment: upstream-lockfile-snapshot.json was captured at dimina@${snapshot.diminaCommit}, ` +
      `but the submodule is now pinned to dimina@${diminaCommit}.\n` +
      'Run: node scripts/snapshot-upstream-versions.js, then commit the refreshed snapshot.',
  )
  process.exit(2)
}

// Scoped to deps kit itself declares. Packages dmcc source imports but kit
// doesn't declare (e.g. @vue/shared, pulled in only via compatibility.js)
// aren't independently resolved by kit at all — kit's esbuild config bundles
// (inlines) anything not in its NODE_EXTERNAL list straight from the dimina/fe
// source file that imports it, so that code is always upstream's current
// install by construction. Drift is only possible for deps kit resolves on
// its own — i.e. the ones it declares here.
const kitDeps = { ...kitPkg.dependencies, ...kitPkg.devDependencies }

const mismatches = []
const unresolved = []

// Every shared dep here is part of dmcc's actual compile pipeline (e.g.
// @vue/compiler-sfc's compileStyle/compileTemplate drive CSS scope-hash and
// template codegen — not a cosmetic tool), so all of them get the same
// resolved-version check as the wasm toolchain, not just oxc-parser/esbuild.
for (const name of Object.keys(kitDeps)) {
  if (!(name in snapshot.versions)) continue

  const kitVersion = await resolveInstalledVersion(kitPkgPath, name)
  const upstreamVersion = snapshot.versions[name]
  if (!kitVersion) {
    unresolved.push(`  ${name}: kit=unresolved upstream(snapshot)=${upstreamVersion}`)
    continue
  }
  if (kitVersion !== upstreamVersion) {
    mismatches.push(`  ${name}: kit resolves ${kitVersion}, upstream snapshot resolves ${upstreamVersion}`)
  }
}

// The wasm builds of oxc-parser/esbuild are peer/dev deps here (native
// bindings aren't available in the browser); their version must track the
// non-wasm package they're a build target of, or the browser bundle can
// silently run a different parser/bundler version than the node bundle.
// Both sides of this pair live in kit's own package.json/node_modules, so
// resolution never depends on dimina/fe being installed.
const wasmPairs = [
  ['oxc-parser', '@oxc-parser/binding-wasm32-wasi'],
  ['esbuild', 'esbuild-wasm'],
]

for (const [nativeName, wasmName] of wasmPairs) {
  const nativeVersion = await resolveInstalledVersion(kitPkgPath, nativeName)
  const wasmVersion = await resolveInstalledVersion(kitPkgPath, wasmName)
  if (!nativeVersion || !wasmVersion) {
    unresolved.push(`  ${wasmName}/${nativeName}: kit=${nativeVersion ?? 'unresolved'}/${wasmVersion ?? 'unresolved'}`)
    continue
  }
  if (nativeVersion !== wasmVersion) {
    mismatches.push(`  ${wasmName} resolves ${wasmVersion}, does not match ${nativeName} resolving ${nativeVersion}`)
  }
}

if (unresolved.length > 0) {
  console.error(
    'check-wasm-alignment: could not resolve installed versions for some shared deps — ' +
      'this proves nothing either way, so treat it as a setup failure, not a pass:\n' +
      unresolved.join('\n') +
      '\nRun: pnpm install',
  )
  process.exit(2)
}

if (mismatches.length > 0) {
  console.error(
    'check-wasm-alignment: drift between packages/compiler and the upstream @dimina/compiler ' +
      'snapshot (dimina submodule) — this package re-implements dmcc against the same toolchain:\n' +
      mismatches.join('\n') +
      '\nRealign the drifted side (bump/pin in package.json, then pnpm install) and rebuild ' +
      '(pnpm --filter @dimina-kit/compiler build).',
  )
  process.exit(1)
}

console.log('check-wasm-alignment: packages/compiler deps aligned with upstream @dimina/compiler snapshot')
