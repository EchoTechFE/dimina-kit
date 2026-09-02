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
  checkBrowserAssetContract,
  resolveBrowserAssets,
} from '../src/browser-assets.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let failed = false
const chk = (cond, msg) => { if (!cond) { failed = true; console.error(`❌ ${msg}`) } else console.log(`✅ ${msg}`) }

const assetNames = COMPILER_BROWSER_ASSETS.map((asset) => asset.name)
const healthy = [
  ...assetNames.map((name) => ({ name, staticImports: [] })),
  ...BUNDLER_ONLY_BROWSER_OUTPUTS.map((name) => ({ name, staticImports: [] })),
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
  checkBrowserAssetContract([...healthy, { name: 'compile-core.browser-chunk.js', staticImports: [] }])
    .some((line) => line.includes('new browser output')),
  'a newly split chunk is reported until it is classified',
)

chk(
  checkBrowserAssetContract(
    healthy.map((output) => (output.name === 'stage-worker.browser.js'
      ? { ...output, staticImports: ['./chunk-ABC.js'] }
      : output)),
  ).some((line) => line.includes('statically imports ./chunk-ABC.js')),
  'an asset that stopped being self-contained is reported',
)

// What the build actually feeds the check: esbuild's metafile, keyed by path,
// carrying both import kinds plus sourcemap entries.
const shaped = browserOutputsFromMetafile({
  outputs: {
    'dist/stage-worker.browser.js': {
      imports: [
        { path: 'toolchainSetupURL', kind: 'dynamic-import' },
        { path: './chunk-XYZ.js', kind: 'import-statement' },
      ],
    },
    'dist/stage-worker.browser.js.map': { imports: [] },
  },
})
chk(shaped.length === 1 && shaped[0].name === 'stage-worker.browser.js', 'metafile paths are reduced to file names, sourcemaps dropped')
chk(
  shaped[0].staticImports.length === 1 && shaped[0].staticImports[0] === './chunk-XYZ.js',
  'a dynamic import (the host toolchain setup URL) is not counted; a static one is',
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
