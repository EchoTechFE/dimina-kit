// Contract tests for src/browser-assets.js — the static-asset manifest hosts copy
// from, and the check build-compiler.js runs against every browser build.
//
// The failure modes below are exactly what the build-time check exists to catch, so
// they are driven here as synthetic output lists (no build step): a renamed output,
// an unclassified new output, and an asset that stopped being self-contained.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUNDLER_ONLY_BROWSER_OUTPUTS,
  COMPILER_BROWSER_ASSETS,
  browserOutputsFromMetafile,
  checkAssetsAgainstExports,
  checkBrowserAssetContract,
  resolveBrowserAssets,
} from '../src/browser-assets.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let failed = false
const chk = (cond, msg) => { if (!cond) { failed = true; console.error(`❌ ${msg}`) } else console.log(`✅ ${msg}`) }

const assetNames = COMPILER_BROWSER_ASSETS.map((asset) => asset.name)
const healthy = [
  ...assetNames.map((name) => ({ name, imports: [] })),
  ...BUNDLER_ONLY_BROWSER_OUTPUTS.map((name) => ({ name, imports: [] })),
]

chk(checkBrowserAssetContract(healthy).length === 0, 'a build that emits exactly the listed outputs passes')

// Every asset is reachable through the exports map, so a host never has to guess
// where dist/ is — and the names in the manifest are the names on disk.
const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'package.json'), 'utf8'))
chk(
  typeof pkg.exports['./browser-assets'] === 'object' && pkg.exports['./browser-assets'].require === './dist/browser-assets.cjs',
  'the manifest is published for CommonJS hosts too (exports["./browser-assets"].require)',
)

const renamed = healthy.map((output) => (output.name === 'pool.browser.js' ? { ...output, name: 'pool.js' } : output))
const renamedProblems = checkBrowserAssetContract(renamed)
chk(
  renamedProblems.some((line) => line.includes('did not emit it')),
  'renaming an output without updating the manifest is reported',
)
chk(
  renamedProblems.some((line) => line.includes('pool.js') && line.includes('new browser output')),
  'the output under its new name is reported as unclassified',
)

chk(
  checkBrowserAssetContract([...healthy, { name: 'compile-core.browser-chunk.js', imports: [] }])
    .some((line) => line.includes('new browser output')),
  'a newly split chunk is reported until it is classified',
)

// An asset only works when it is one file with nothing to fetch alongside it, so
// every import kind breaks it — not just `import … from`. An externalized CJS
// dependency shows up as require-call, a lazily pulled chunk as dynamic-import.
for (const kind of ['import-statement', 'require-call', 'dynamic-import']) {
  chk(
    checkBrowserAssetContract(
      healthy.map((output) => (output.name === 'stage-worker.browser.js'
        ? { ...output, imports: [{ path: './chunk-ABC.js', kind }] }
        : output)),
    ).some((line) => line.includes('not self-contained') && line.includes(`./chunk-ABC.js (${kind})`)),
    `an asset that imports something (${kind}) is reported`,
  )
}

// An output emitted into a subdirectory is NOT the dist-root file a host copies,
// so it must not pass as one.
const nested = checkBrowserAssetContract([
  ...healthy.filter((output) => output.name !== 'pool.browser.js'),
  { name: 'assets/pool.browser.js', imports: [] },
])
chk(nested.some((line) => line.includes('dist/pool.browser.js') && line.includes('did not emit it')), 'an asset moved into a subdirectory is reported as missing from dist')
chk(nested.some((line) => line.includes('dist/assets/pool.browser.js') && line.includes('new browser output')), 'the subdirectory copy is reported under its full path')

// What the build actually feeds the check: esbuild's metafile, keyed by paths
// relative to the working directory, plus sourcemap entries.
const shaped = browserOutputsFromMetafile({
  outputs: {
    'dist/stage-worker.browser.js': { imports: [{ path: './chunk-XYZ.js', kind: 'import-statement' }] },
    'dist/assets/pool.browser.js': { imports: [] },
    'dist/stage-worker.browser.js.map': { imports: [] },
  },
})
chk(
  shaped.map((output) => output.name).join('|') === 'stage-worker.browser.js|assets/pool.browser.js',
  'metafile paths keep the directory below dist, sourcemaps dropped',
)
chk(
  shaped[0].imports.length === 1 && shaped[0].imports[0].kind === 'import-statement',
  'each import is carried through with its kind',
)

// The manifest and the exports map name the same files; a rename has to land in both.
chk(checkAssetsAgainstExports(pkg.exports).length === 0, "this package's own exports map agrees with the manifest")
chk(
  checkAssetsAgainstExports({ './pool': { default: './dist/pool-v2.browser.js' } })
    .some((line) => line.includes('pool-v2.browser.js') && line.includes('does not list')),
  'an export pointing at an unlisted browser bundle is reported',
)
chk(
  checkAssetsAgainstExports({ './pool': { default: './dist/pool-v2.browser.js' } })
    .some((line) => line.includes('pool.browser.js') && line.includes('one half of a rename')),
  'a listed asset no export points at is reported',
)

// resolveBrowserAssets is the path every consumer derives from the ./browser entry.
const posix = resolveBrowserAssets('/app/node_modules/@dimina-kit/compiler/dist/compile-core.browser.js')
chk(posix.dir === '/app/node_modules/@dimina-kit/compiler/dist', 'POSIX: dir is the entry directory')
chk(
  posix.files.join('|') === assetNames.map((name) => `${posix.dir}/${name}`).join('|'),
  'POSIX: every asset resolves as a sibling of the entry, in manifest order',
)

const win = resolveBrowserAssets('C:\\app\\node_modules\\@dimina-kit\\compiler\\dist\\compile-core.browser.js')
chk(win.files[0] === 'C:\\app\\node_modules\\@dimina-kit\\compiler\\dist\\stage-worker.browser.js', 'Windows separators are preserved')

let threw = false
try { resolveBrowserAssets('compile-core.browser.js') } catch { threw = true }
chk(threw, 'a bare file name (not a path) is rejected rather than silently resolved to ""')

// If dist is already built, the manifest must describe what is actually there.
const dist = path.join(root, 'dist')
if (existsSync(path.join(dist, 'compile-core.browser.js'))) {
  const missing = resolveBrowserAssets(path.join(dist, 'compile-core.browser.js')).files.filter((file) => !existsSync(file))
  chk(missing.length === 0, `built dist contains every listed asset${missing.length ? `: missing ${missing.join(', ')}` : ''}`)
} else {
  console.log('ℹ️  dist not built — skipped the on-disk check (the browser build runs it itself)')
}

console.log(failed ? '\n❌ FAIL' : '\n✅ PASS: browser static-asset manifest and contract check behave')
process.exitCode = failed ? 1 : 0
