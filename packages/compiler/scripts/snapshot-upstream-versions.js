import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { resolveInstalledVersion } from './resolve-installed-version.js'

function printUsage() {
  console.log(
    'Usage: node scripts/snapshot-upstream-versions.js\n\n' +
      'Freezes the versions upstream @dimina/compiler (dimina submodule,\n' +
      'dimina/fe/packages/compiler) currently resolves for every dependency it shares\n' +
      "with packages/compiler, into upstream-lockfile-snapshot.json, tagged with the\n" +
      "submodule's current commit. check:wasm-alignment compares against this frozen\n" +
      'snapshot instead of re-resolving upstream live — dimina/fe has no committed\n' +
      "lockfile, so a live resolve isn't reproducible between runs.\n\n" +
      'Run this after bumping the dimina submodule pointer, or after adding/upgrading a\n' +
      "packages/compiler dependency that upstream also declares. Requires dimina/fe's\n" +
      'own workspace to be installed: pnpm -C dimina/fe install --no-frozen-lockfile.',
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
const diminaFeRoot = path.join(diminaRoot, 'fe')
const upstreamPkgPath = path.join(diminaFeRoot, 'packages/compiler/package.json')
const snapshotPath = path.join(root, 'upstream-lockfile-snapshot.json')

async function readJson(p) {
  return JSON.parse(await readFile(p, 'utf8'))
}

const kitPkg = await readJson(kitPkgPath)
let upstreamPkg
try {
  upstreamPkg = await readJson(upstreamPkgPath)
} catch (err) {
  console.error(
    `snapshot-upstream-versions: could not read upstream package.json at ${upstreamPkgPath} (${err.message})\n` +
      'The dimina submodule looks uninitialized. Run: git submodule update --init dimina',
  )
  process.exit(2)
}

let diminaCommit
try {
  diminaCommit = execFileSync('git', ['-C', diminaRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
} catch (err) {
  console.error(`snapshot-upstream-versions: could not read dimina submodule HEAD (${err.message})`)
  process.exit(2)
}

// Same shared-dep discovery as check-wasm-alignment.js: scoped to deps kit
// itself declares, so a newly-shared dependency is picked up automatically
// the next time this script runs.
const kitDeps = { ...kitPkg.dependencies, ...kitPkg.devDependencies }
const upstreamDeps = { ...upstreamPkg.dependencies }

const versions = {}
const unresolved = []

for (const name of Object.keys(kitDeps)) {
  if (!(name in upstreamDeps)) continue
  const version = await resolveInstalledVersion(upstreamPkgPath, name, diminaFeRoot)
  if (!version) {
    unresolved.push(name)
    continue
  }
  versions[name] = version
}

if (unresolved.length > 0) {
  console.error(
    'snapshot-upstream-versions: could not resolve upstream-installed versions for:\n' +
      unresolved.map((name) => `  ${name}`).join('\n') +
      '\nRun: pnpm -C dimina/fe install --no-frozen-lockfile',
  )
  process.exit(2)
}

const snapshot = { diminaCommit, versions }
await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`)
console.log(`snapshot-upstream-versions: wrote ${Object.keys(versions).length} versions to ${path.relative(root, snapshotPath)} (dimina@${diminaCommit})`)
