// An image that a page references must survive the whole compile: seeded as bytes,
// copied by the compiler into the product, and handed back byte-identical. It used to
// come back corrupted — collectOutputs read every product with 'utf8', which replaces
// each invalid byte with U+FFFD and cannot be undone, so downstreams were told in the
// README to go read the fs themselves for real assets.
//
// Two levels, because the bytes have to survive two different journeys:
//   PART A — the real browser pool (dist/pool.browser.js + dist/stage-worker.browser.js):
//            source bytes cross into a worker realm and products cross back, both through
//            structured cloning. This is the path a host actually calls.
//   PART B — the compile seams (setupCompile/compileStage/collectOutputs) against the
//            `base` example, which references pages/project-mixed/pages/detail/ui.png
//            from its wxml, plus the byte-exactness rules collectOutputs itself owns.

// Warm real esbuild/oxc-parser module eval AND esbuild's long-lived service child
// process with the REAL process object BEFORE masking (below) — the service, once
// spawned, is reused for later transforms even under a masked process, so this must
// run first.
import { transform } from 'esbuild'
import 'oxc-parser'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { seedMemfs } from '../src/seed-memfs.js'

await transform('const __warm = 1', {})

const APP = process.env.APP_DIR
  || fileURLToPath(new URL('../../../dimina/fe/example/base', import.meta.url))

const TEXT_EXT = new Set([
  '.json', '.js', '.ts', '.wxml', '.ddml', '.wxss', '.ddss', '.less',
  '.scss', '.sass', '.wxs', '.dds', '.css',
])

let failed = 0
const chk = (cond, msg) => { if (cond) { console.log(`✅ ${msg}`) } else { console.log(`❌ ${msg}`); failed++ } }
const sameBytes = (a, b) => a && b && a.length === b.length && [...a].every((x, i) => x === b[i])

// Unlike the older seams tests, this one seeds binary files too — that filter was the
// workaround for the gap under test here.
const files = {}
const readDir = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) { readDir(full); continue }
    const rel = path.relative(APP, full).split(path.sep).join('/')
    files[rel] = TEXT_EXT.has(path.extname(name).toLowerCase())
      ? readFileSync(full, 'utf8')
      : new Uint8Array(readFileSync(full))
  }
}
readDir(APP)

const binarySources = Object.entries(files).filter(([, v]) => v instanceof Uint8Array)
chk(binarySources.length > 0, `the fixture really carries binary sources (${binarySources.map(([k]) => k).join(', ')})`)
const IMAGE_BYTES = binarySources.length > 0 ? binarySources[0][1] : new Uint8Array([0x89, 0x50, 0x4E, 0x47])

// --- PART A: the real browser pool, bytes through structured cloning ------------
//
// The seams in PART B never leave this realm, so they cannot show whether the bytes
// survive postMessage in either direction — the worker seeds its own memfs from the
// cloned source map, and the product map is cloned back. A Uint8Array that arrived as
// a plain object, or a product silently decoded before being posted, would pass every
// PART B assertion and still hand the host a corrupt image.
//
// dart-sass's bundled browser shim checks process.versions.node at module-eval time
// (only reached once the lazily-loaded style-compiler chunk imports it) — masking to a
// browser-shaped stub makes it take the browser branch instead of crashing on
// `Dynamic require of "url" is not supported`. Saved so PART B (a Node-target bundle,
// whose transitive deps module-eval-check process.versions.node too) can restore it.
const realProcess = globalThis.process
globalThis.process = { env: {}, cwd: () => '/' }

const WORKER_URL = new URL('../dist/stage-worker.browser.js', import.meta.url).href
const TOOLCHAIN_URL = new URL('./toolchain-setup-node-native.js', import.meta.url).href
const WORK_PATH = '/work'

// A page that references one image, so the compiler has a reason to copy it.
const POOL_FIXTURE = {
  'app.json': JSON.stringify({ pages: ['pages/index/index'] }),
  'project.config.json': JSON.stringify({ appid: 'binary_outputs_001', projectname: 'binary-outputs' }),
  'app.js': 'App({})\n',
  'pages/index/index.js': "Page({ data: { title: 'binary' } })\n",
  'pages/index/index.json': JSON.stringify({ navigationBarTitleText: 'binary' }),
  'pages/index/index.wxss': '.box { padding: 20rpx; }\n',
  'pages/index/index.wxml': '<view class="box">\n  <image src="./logo.png" mode="aspectFit"></image>\n</view>\n',
  'pages/index/logo.png': IMAGE_BYTES,
}

// Each stage worker is its own dynamically-imported module instance (own closure state,
// mirroring a real Web Worker realm); ALL of them funnel through one shared `chain` so
// only one is ever in flight — the worker module resolves the bare `self` identifier
// against whatever `globalThis.self` currently is, so serializing every send keeps two
// realms' async continuations from racing over that shared global.
let chain = Promise.resolve()
let instanceCounter = 0
async function makeStageWorker() {
  const worker = { onmessage: null, onerror: null, terminate() {} }
  const fakeSelf = {
    onmessage: null,
    // structuredClone is what a real postMessage does; without it this harness would
    // hand the pool the very same Uint8Array instance and prove nothing about cloning.
    postMessage(msg) { if (worker.onmessage) worker.onmessage({ data: structuredClone(msg) }) },
  }
  globalThis.self = fakeSelf
  instanceCounter += 1
  await import(`${WORKER_URL}?n=${instanceCounter}`)
  // stage-worker.js does `self.onmessage = async (e) => {...}` at module top level
  // against whatever `globalThis.self` was AT IMPORT TIME — capture it now.
  const boundOnMessage = fakeSelf.onmessage
  worker.postMessage = (msg) => {
    const cloned = structuredClone(msg)
    chain = chain.then(async () => {
      globalThis.self = fakeSelf
      try {
        await boundOnMessage({ data: cloned })
      } catch (err) {
        // The real handler already catches internally and posts { type:'error' }; an
        // escaping exception would mean it threw before its own try, so surface it the
        // same way rather than hanging the pool's pending request forever.
        fakeSelf.postMessage({ type: 'error', error: String((err && err.stack) || err) })
      }
    })
  }
  return worker
}

{
  const { createCompilerPool } = await import('../dist/pool.browser.js')
  const stageWorkers = []
  for (const _stage of ['logic', 'view', 'style']) stageWorkers.push(await makeStageWorker())
  let nextWorker = 0
  const pool = createCompilerPool({
    createWorker: () => stageWorkers[nextWorker++],
    toolchainSetupURL: TOOLCHAIN_URL,
  })
  const out = await pool.compile({ files: POOL_FIXTURE, workPath: WORK_PATH })
  await pool.dispose()

  const products = Object.entries(out.files)
  const match = products.find(([, v]) => v instanceof Uint8Array && sameBytes(v, IMAGE_BYTES))
  chk(!!match,
    `PART A (pool.js + stage-worker.js): the referenced image came back byte-identical through structured cloning${match ? ` (as ${match[0]})` : ` — got ${JSON.stringify(products.filter(([k]) => k.endsWith('.png')).map(([k, v]) => [k, v instanceof Uint8Array ? `bytes(${v.length})` : typeof v]))}`}`)
  chk(!!match && !sameBytes(POOL_FIXTURE['pages/index/logo.png'], new Uint8Array(0)),
    'PART A: and the source bytes it was compared against are non-empty')
  const poolMojibake = products.filter(([, v]) => typeof v === 'string' && v.includes('�'))
  chk(poolMojibake.length === 0, `PART A: no product came back with replacement characters (${poolMojibake.map(([k]) => k).join(', ') || 'none'})`)
  const poolJs = out.files['main/pages_index_index.js']
  chk(typeof poolJs === 'string' && poolJs.length > 0, 'PART A: text products are still plain strings (the page module compiled)')
}

// --- PART B: the compile seams, against the full `base` example ------------------
globalThis.process = realProcess

const { setupCompile, compileStage, collectOutputs, STAGE_NAMES } = await import('../dist/compile-core.node.js')

const workPath = '/work'
const fs = seedMemfs(files, workPath)
const ctx = await setupCompile({ fs, workPath })
for (const stage of STAGE_NAMES) {
  await compileStage({ stage, pages: ctx.pages, storeInfo: ctx.storeInfo, fs })
}
const out = collectOutputs({ fs, targetPath: ctx.targetPath })

const products = Object.entries(out)
const byteProducts = products.filter(([, v]) => v instanceof Uint8Array)
chk(byteProducts.length > 0,
  `the compiler's copied assets come back as bytes, not decoded text (${byteProducts.length} of ${products.length} products: ${byteProducts.map(([k]) => k).join(', ')})`)

for (const [srcPath, srcBytes] of binarySources) {
  const match = byteProducts.find(([, v]) => sameBytes(v, srcBytes))
  const copied = products.some(([k]) => k.endsWith(path.basename(srcPath)))
  // Only assets a page actually references are copied into the product; one that is
  // never referenced legitimately has no product to compare against.
  if (match) chk(true, `${srcPath} reached the product byte-identical (as ${match[0]})`)
  else chk(!copied, `${srcPath} is not referenced by any page, so it has no product (nothing named like it was emitted)`)
}

const appConfig = out[Object.keys(out).find((k) => k.endsWith('app-config.json'))]
chk(typeof appConfig === 'string' && JSON.parse(appConfig), 'UTF-8 products are still plain strings (app-config.json parses)')
const jsProducts = products.filter(([k, v]) => k.endsWith('.js') && typeof v === 'string')
chk(jsProducts.length > 0, `compiled JS products are still strings (${jsProducts.length} of them)`)
const cssProducts = products.filter(([k, v]) => k.endsWith('.css') && typeof v === 'string')
chk(cssProducts.length > 0, `compiled CSS products are still strings (${cssProducts.length} of them)`)
const mojibake = products.filter(([, v]) => typeof v === 'string' && v.includes('�'))
chk(mojibake.length === 0, `no product came back with replacement characters (${mojibake.map(([k]) => k).join(', ') || 'none'})`)

// A product that starts with a UTF-8 BOM must come back with the BOM still on it. The
// compiler copies referenced assets verbatim, and a .svg or .json asset written by an
// editor that emits a BOM is valid UTF-8 — so it decodes to a string, and a decoder
// that eats the BOM would hand the host a file three bytes shorter than the one on
// disk, silently, with no bytes-vs-text signal to notice it by.
{
  const bomBytes = new Uint8Array([0xEF, 0xBB, 0xBF, ...new TextEncoder().encode('{"a":1}')])
  fs.writeFileSync(`${ctx.targetPath}/bom-asset.json`, bomBytes)
  const collected = collectOutputs({ fs, targetPath: ctx.targetPath })['bom-asset.json']
  const roundTripped = typeof collected === 'string' ? new TextEncoder().encode(collected) : collected
  chk(sameBytes(roundTripped, bomBytes),
    `a BOM-prefixed product survives byte-identical (${bomBytes.length} bytes in, ${roundTripped ? roundTripped.length : 'nothing'} out)`)
}

console.log(failed ? `\n❌ ${failed} binary-output assertion(s) failed.` : '\n✅ referenced assets survive the compile byte-identical, through the pool and through the seams; text products are unchanged.')
process.exit(failed ? 1 : 0)
