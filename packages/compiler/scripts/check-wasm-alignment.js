import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'

function printUsage() {
  console.log(
    'Usage: node scripts/check-wasm-alignment.js\n\n' +
      'Fails if packages/compiler and upstream @dimina/compiler (dimina submodule,\n' +
      'dimina/fe/packages/compiler) resolve any shared dependency — or the wasm/native\n' +
      'build pairs oxc-parser/@oxc-parser/binding-wasm32-wasi and esbuild/esbuild-wasm —\n' +
      'to a different installed version. Requires both workspaces to be installed\n' +
      '(pnpm install, pnpm -C dimina/fe install).',
  )
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  printUsage()
  process.exit(0)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const kitPkgPath = path.join(root, 'package.json')
const diminaFeRoot = path.resolve(root, '../../dimina/fe')
const upstreamPkgPath = path.join(diminaFeRoot, 'packages/compiler/package.json')

async function readJson(p) {
  return JSON.parse(await readFile(p, 'utf8'))
}

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

// package.json only records the declared semver *range* (e.g. "^3.5.39");
// for a dep whose major is >=1 that range also matches later minors
// installed independently on each side. Walk the actual node_modules
// resolution each side's own package.json would use, and climb to the
// nearest package.json whose name matches (not just the first package.json
// found, which could belong to a nested dependency).
//
// requiredPrefix guards the upstream (dimina/fe) side specifically: dimina/fe
// is nested inside this repo, so if its own node_modules isn't installed,
// Node's resolution walks up past it and can silently land in kit's own
// hoisted node_modules — "resolved" would then just be comparing kit against
// itself and reporting false alignment. Reject any resolution that doesn't
// land under dimina/fe instead of treating it as a valid answer.
async function resolveInstalledVersion(anchorPackageJsonPath, depName, requiredPrefix) {
  let entry
  try {
    entry = createRequire(anchorPackageJsonPath).resolve(depName)
  } catch {
    return null
  }
  if (requiredPrefix && !entry.startsWith(requiredPrefix + path.sep)) {
    return null
  }
  let dir = path.dirname(entry)
  for (let hop = 0; hop < 16; hop++) {
    const candidate = path.join(dir, 'package.json')
    if (await exists(candidate)) {
      const pkg = await readJson(candidate)
      if (pkg.name === depName) return pkg.version
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

// This package's node/browser bundles are esbuild-driven mirrors of
// @dimina/compiler (upstream, in the dimina submodule) — same compiler
// logic against a caller-injected fs. Compare live, not a hardcoded dep
// list, so a newly-shared dependency is picked up automatically.
const kitPkg = await readJson(kitPkgPath)
let upstreamPkg
try {
  upstreamPkg = await readJson(upstreamPkgPath)
} catch (err) {
  console.error(
    `check-wasm-alignment: could not read upstream package.json at ${upstreamPkgPath} (${err.message})\n` +
      'The dimina submodule looks uninitialized. Run: git submodule update --init dimina',
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
const upstreamDeps = { ...upstreamPkg.dependencies }

const mismatches = []
const unresolved = []

// Every shared dep here is part of dmcc's actual compile pipeline (e.g.
// @vue/compiler-sfc's compileStyle/compileTemplate drive CSS scope-hash and
// template codegen — not a cosmetic tool), so all of them get the same
// resolved-version check as the wasm toolchain, not just oxc-parser/esbuild.
// dimina/fe doesn't commit a lockfile (gitignored upstream), so its resolved
// version can drift from kit's pinned lockfile purely from the passage of
// time — that drift is exactly what this check exists to catch, not noise
// to suppress by only comparing the declared specifier string.
for (const name of Object.keys(kitDeps)) {
  if (!(name in upstreamDeps)) continue

  const kitVersion = await resolveInstalledVersion(kitPkgPath, name)
  const upstreamVersion = await resolveInstalledVersion(upstreamPkgPath, name, diminaFeRoot)
  if (!kitVersion || !upstreamVersion) {
    unresolved.push(`  ${name}: kit=${kitVersion ?? 'unresolved'} upstream=${upstreamVersion ?? 'unresolved'}`)
    continue
  }
  if (kitVersion !== upstreamVersion) {
    mismatches.push(`  ${name}: kit resolves ${kitVersion}, upstream(@dimina/compiler) resolves ${upstreamVersion}`)
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
      '\nRun: pnpm install && pnpm -C dimina/fe install',
  )
  process.exit(2)
}

if (mismatches.length > 0) {
  console.error(
    'check-wasm-alignment: drift between packages/compiler and upstream @dimina/compiler ' +
      '(dimina submodule) — this package re-implements dmcc against the same toolchain:\n' +
      mismatches.join('\n') +
      '\nRealign the drifted side (bump/pin in package.json, then pnpm install) and rebuild ' +
      '(pnpm --filter @dimina-kit/compiler build).',
  )
  process.exit(1)
}

console.log('check-wasm-alignment: packages/compiler deps aligned with upstream @dimina/compiler')
