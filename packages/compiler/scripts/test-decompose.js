// Decomposed-path test: drive the parallel seams directly — setupCompile once,
// then each stage (logic/view/style) on its own, then collectOutputs — the exact
// call shape the parallel worker pipeline uses (minus the multi-realm split, which
// Phase 3's real workers add). Proves two things Phase 3 relies on:
//   1. the seams are callable directly (not only through compileMiniApp), and
//   2. each stage writes ONLY its own products (disjoint outputs) — the invariant
//      that lets stages run concurrently over one shared fs.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Volume, createFsFromVolume } from 'memfs'

const APP = process.env.APP_DIR
  || fileURLToPath(new URL('../../../dimina/fe/example/base', import.meta.url))

const TEXT_EXT = new Set([
  '.json', '.js', '.ts', '.wxml', '.ddml', '.wxss', '.ddss', '.less',
  '.scss', '.sass', '.wxs', '.dds', '.css',
])

function readDir(dir, baseDir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      readDir(full, baseDir, out)
    } else {
      const rel = path.relative(baseDir, full).split(path.sep).join('/')
      if (TEXT_EXT.has(path.extname(name).toLowerCase())) out[rel] = readFileSync(full, 'utf8')
    }
  }
}

let failed = 0
function check(cond, msg) {
  if (cond) console.log(`  ✅ ${msg}`)
  else { console.log(`  ❌ ${msg}`); failed++ }
}

const files = {}
readDir(APP, APP, files)
console.log(`[seed] ${Object.keys(files).length} text files from ${APP}`)

const {
  setupCompile, compileStage, collectOutputs, STAGE_NAMES,
} = await import('../dist/compile-core.node.js')

const workPath = '/work'
const fs = createFsFromVolume(Volume.fromJSON(files, workPath))

// --- setup once ---
const ctx = await setupCompile({ fs, workPath })
console.log(`\n[setup] appId=${ctx.appId} name=${ctx.name} target=${ctx.targetPath}`)
check(STAGE_NAMES.join(',') === 'logic,view,style', `STAGE_NAMES = [${STAGE_NAMES}]`)
check(typeof ctx.storeInfo === 'object' && !!ctx.pages, 'setupCompile returns { storeInfo, pages }')

const cssCount = (m) => Object.keys(m).filter((k) => k.endsWith('.css')).length
const jsCount = (m) => Object.keys(m).filter((k) => k.endsWith('.js')).length

const stageArgs = { pages: ctx.pages, storeInfo: ctx.storeInfo, fs }

// --- logic only: main/logic.js appears; no styles yet ---
await compileStage({ stage: 'logic', ...stageArgs })
const afterLogic = collectOutputs({ fs, targetPath: ctx.targetPath })
console.log(`\n[after logic] ${Object.keys(afterLogic).length} files, js=${jsCount(afterLogic)} css=${cssCount(afterLogic)}`)
check('main/logic.js' in afterLogic, 'logic stage wrote main/logic.js')
check(cssCount(afterLogic) === 0, 'logic stage wrote NO .css (style stage untouched)')

// --- view: page view scripts appear; still no styles ---
await compileStage({ stage: 'view', ...stageArgs })
const afterView = collectOutputs({ fs, targetPath: ctx.targetPath })
console.log(`[after view]  ${Object.keys(afterView).length} files, js=${jsCount(afterView)} css=${cssCount(afterView)}`)
check(jsCount(afterView) > jsCount(afterLogic), 'view stage added page view .js files')
check(cssCount(afterView) === 0, 'view stage wrote NO .css (style stage untouched)')

// --- style: .css appears now ---
await compileStage({ stage: 'style', ...stageArgs })
const out = collectOutputs({ fs, targetPath: ctx.targetPath })
console.log(`[after style] ${Object.keys(out).length} files, js=${jsCount(out)} css=${cssCount(out)}`)
check(cssCount(out) > 0, 'style stage wrote .css files')

// --- full artifact set (same expectations as test-node) ---
for (const n of ['main/logic.js', 'main/app-config.json']) {
  check(n in out && out[n].length > 0, `output has non-empty ${n}`)
}
check(out['main/logic.js'].startsWith('modDefine('), 'main/logic.js starts with modDefine(')

console.log(`\n────────────────────────────────────────────────────────`)
if (failed) { console.error(`❌ ${failed} decompose assertion(s) failed.`); process.exit(1) }
console.log('✅ Decomposed seams work independently; stages write disjoint products.')
