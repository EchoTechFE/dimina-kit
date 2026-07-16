// Content-level scope-hash consistency check for the stage-parallel pool.
//
// The pool's structural-equivalence tests (test:pool-node) only compare file
// NAME/length multisets, so they cannot see whether the `data-v-<id>` scope hashes
// baked into the CSS (`[data-v-<id>]` selectors) actually match the ones baked into
// the compiled render templates (`id:"<id>"`). Scope ids are a deterministic
// hash(path) (dimina utils.js), so stages compiling in separate realms derive
// identical ids; were the id ever per-realm state (a random uuid), the view and style
// stages would diverge and every WXSS rule would target a selector that never renders.
//
// This script models the browser pool (src/pool.js + src/stage-worker.js) in Node:
// each stage compiles in its OWN fresh memfs, exactly as a separate Web Worker realm
// would. It asserts, at the content level, that every scope hash used in CSS also
// appears in the render output — for per-stage independent setup (MODEL A, which
// deterministic ids keep consistent with no broadcast), the shared-setup broadcast
// de-dup path (MODEL B), and the real pool orchestration (MODEL C).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Volume, createFsFromVolume } from 'memfs'

const APP = process.env.APP_DIR
  || fileURLToPath(new URL('../../../dimina/fe/example/vant', import.meta.url))

const TEXT_EXT = new Set([
  '.json', '.js', '.ts', '.wxml', '.ddml', '.wxss', '.ddss', '.less',
  '.scss', '.sass', '.wxs', '.dds', '.css',
])
function readDir(dir, baseDir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) readDir(full, baseDir, out)
    else if (TEXT_EXT.has(path.extname(name).toLowerCase())) {
      out[path.relative(baseDir, full).split(path.sep).join('/')] = readFileSync(full, 'utf8')
    }
  }
}

const seed = {}
readDir(APP, APP, seed)
console.log(`[seed] ${Object.keys(seed).length} text files from ${APP}`)

const workPath = '/work'
const core = await import('../dist/compile-core.node.js')
const { setupCompile, compileStage, collectOutputs, compileMiniApp, resetCompilerState } = core
// The pool orchestration under test is the real source module (pure ESM, no
// browser-only imports), driven below through a mock worker backed by node core.
const { createCompilerPool } = await import('../src/pool.js')
const fileSet = (m) => Object.keys(m).sort().join('\n')

// Every realm in the real pool (setup worker AND each stage worker) calls
// resetCompilerState() before it works (stage-worker.js). In this single-process
// model, separate Web Worker realms are simulated by calling it before each
// realm-equivalent operation so module-level caches never leak between them.
const realm = () => resetCompilerState()

const STAGES = ['logic', 'view', 'style']
const freshFs = () => createFsFromVolume(Volume.fromJSON(seed, workPath))
const clean = (m) => { for (const k of Object.keys(m)) if (m[k] == null) delete m[k]; return m }

// CSS carries the scope hash as `[data-v-<id>]`; the compiled render carries the SAME
// id bare in each `Module({ …, id:"<id>", … })` (the runtime prepends `data-v-`).
// Extract each with its own pattern so we compare the cross-file linkage the runtime
// actually relies on.
function hashesIn(files, pred, re) {
  const set = new Set()
  for (const k of Object.keys(files)) {
    if (!pred(k)) continue
    const v = files[k]
    if (typeof v !== 'string') continue
    let m
    re.lastIndex = 0
    while ((m = re.exec(v))) set.add(m[1])
  }
  return set
}
// `{5,}` (not a fixed width): the scope id is a base36 hash(path) (~13 chars today).
// Keeping an open lower bound of 5 still matches a regressed random 5-char id, so a
// revert to per-realm random ids makes MODEL A orphan again instead of matching nothing.
const CSS_RE = /data-v-([a-z0-9]{5,})/g
const RENDER_RE = /\bid:\s*["']([a-z0-9]{5,})["']/g
const isCss = (k) => k.endsWith('.css')
const isRender = (k) => k.endsWith('.js') && k !== 'main/logic.js' && !k.endsWith('/logic.js')

// Report the CSS-vs-render scope-hash relationship for a merged output map.
function report(label, files) {
  const css = hashesIn(files, isCss, CSS_RE)
  const js = hashesIn(files, isRender, RENDER_RE)
  const orphanCss = [...css].filter((h) => !js.has(h)) // CSS selectors that target nothing rendered
  const matched = [...css].filter((h) => js.has(h))
  console.log(`\n[${label}] css-scope-hashes=${css.size} render-scope-hashes=${js.size} `
    + `matched=${matched.length} orphanCSS=${orphanCss.length}`)
  if (orphanCss.length) {
    console.log(`   orphan CSS hashes (in CSS, absent from render): ${orphanCss.slice(0, 10).join(', ')}${orphanCss.length > 10 ? ' …' : ''}`)
  }
  return { css, js, orphanCss, matched }
}

// --- MODEL A: each stage runs setupCompile in its OWN realm, no broadcast ---
// The direct regression guard: deterministic hash(path) ids must keep independent
// realms consistent. A revert to per-realm random ids surfaces here as orphan CSS.
async function buildPerStageSetup() {
  const merged = {}
  for (const stage of STAGES) {
    realm()
    const fs = freshFs()
    const ctx = await setupCompile({ fs, workPath }) // independent id allocation per stage
    await compileStage({ stage, pages: ctx.pages, storeInfo: ctx.storeInfo, fs })
    Object.assign(merged, clean(collectOutputs({ fs, targetPath: ctx.targetPath })))
  }
  return merged
}

// --- MODEL B: setup ONCE, broadcast the bundle across stage realms (de-dup path) ---
// Models the pool's broadcast path (mirrors the Node disk pool): one realm runs
// setupCompile (npm/app-config scaffold + { pages, storeInfo }); that bundle is
// broadcast to every stage worker, which only runs compileStage against it — so the
// heavy setup runs once. Setup scaffold (app-config.json + npm) is merged in.
async function buildSharedSetup() {
  realm()
  const setupFs = freshFs()
  const ctx = await setupCompile({ fs: setupFs, workPath })
  const bundle = { pages: ctx.pages, storeInfo: ctx.storeInfo, targetPath: ctx.targetPath, appId: ctx.appId, name: ctx.name }
  const merged = clean(collectOutputs({ fs: setupFs, targetPath: ctx.targetPath })) // setup scaffold
  for (const stage of STAGES) {
    realm()
    const fs = freshFs()
    // structuredClone mimics the structured-clone every postMessage bundle undergoes.
    const b = structuredClone(bundle)
    await compileStage({ stage, pages: b.pages, storeInfo: b.storeInfo, fs })
    Object.assign(merged, clean(collectOutputs({ fs, targetPath: b.targetPath })))
  }
  return merged
}

// --- MODEL C: the REAL src/pool.js orchestration, driven by a mock worker ---
// Exercises the actual pool code (setup phase → broadcast bundle → merge scaffold)
// that the browser ships, but backs each "worker" with node core so no wasm/Web
// Worker is needed. Separate Web Worker realms are modeled by serializing every
// handler through one chain (isolated module state) + resetCompilerState per op —
// so this proves the pool's WIRING keeps scope hashes consistent, not just the
// compile-core sequence MODEL B covers.
// One shared chain across ALL mock workers: a real Web Worker is its own realm with
// its own compile-core module (fs backend, env singletons), but here every mock
// worker shares this process's single node core module. Serializing all handlers
// through one chain models that realm isolation (only one core op runs at a time),
// so pool.js's parallel compile-subset dispatch can't cross-corrupt the shared fs.
let mockChain = Promise.resolve()
function makeMockWorker() {
  const w = { onmessage: null, onerror: null, terminate() {} }
  w.postMessage = (msg) => {
    mockChain = mockChain.then(async () => {
      let reply
      try {
        if (msg.type === 'warmup') {
          reply = { type: 'ready', ms: 0 }
        } else if (msg.type === 'setup') {
          realm()
          const fs = createFsFromVolume(Volume.fromJSON(msg.files, msg.workPath))
          const ctx = await setupCompile({ fs, workPath: msg.workPath })
          reply = {
            type: 'setup-done',
            bundle: { pages: ctx.pages, storeInfo: ctx.storeInfo, targetPath: ctx.targetPath, appId: ctx.appId, name: ctx.name },
            scaffold: clean(collectOutputs({ fs, targetPath: ctx.targetPath })),
          }
        } else if (msg.type === 'compile-subset') {
          realm()
          const fs = createFsFromVolume(Volume.fromJSON(msg.files, msg.workPath))
          const b = structuredClone(msg.bundle) // mimic postMessage structured clone
          for (const stage of msg.stages) await compileStage({ stage, pages: b.pages, storeInfo: b.storeInfo, fs })
          reply = { type: 'done', result: { appId: b.appId, name: b.name, files: clean(collectOutputs({ fs, targetPath: b.targetPath })) } }
        }
      } catch (e) {
        reply = { type: 'error', error: String((e && e.stack) || e) }
      }
      queueMicrotask(() => { if (w.onmessage) w.onmessage({ data: reply }) })
    })
  }
  return w
}
async function buildViaPool() {
  const pool = createCompilerPool({ createWorker: makeMockWorker, toolchainSetupURL: 'noop://toolchain' })
  const res = await pool.compile({ files: seed, workPath })
  pool.dispose()
  return res
}

// --- ground truth: single-realm compileMiniApp ---
realm()
const inline = clean((await compileMiniApp({ fs: freshFs(), workPath })).files)
const gt = report('inline (single realm, ground truth)', inline)

const modelA = await buildPerStageSetup()
const rA = report('MODEL A — per-stage independent setup (no broadcast)', modelA)

const modelB = await buildSharedSetup()
const rB = report('MODEL B — shared setup broadcast (de-dup path)', modelB)

const poolRes = await buildViaPool()
const modelC = clean(poolRes.files)
const rC = report('MODEL C — real src/pool.js orchestration (mock worker)', modelC)

let failed = false
const fail = (m) => { failed = true; console.error(`❌ ${m}`) }
const pass = (m) => console.log(`✅ ${m}`)

// Ground truth must be self-consistent (every CSS hash targets a rendered element).
if (gt.orphanCss.length) fail(`ground truth has ${gt.orphanCss.length} orphan CSS hashes — test harness bug`)
else pass('ground truth: every CSS scope hash appears in the render output')

// With deterministic hash(path) scope ids, per-stage INDEPENDENT setup (MODEL A) must
// stay scope-consistent too: separate realms derive the SAME id from the same path with
// no broadcast. This is the guarantee stable ids buy, and the direct regression guard —
// a revert to per-realm random ids would make MODEL A orphan again.
if (rA.orphanCss.length === 0 && rA.css.size === gt.css.size) {
  pass(`STABLE ID: per-stage independent setup yields 0 orphan CSS hashes, ${rA.matched.length} matched (== ground truth ${gt.css.size}) — deterministic hash(path) keeps realms consistent without a broadcast`)
} else {
  fail(`per-stage independent setup has ${rA.orphanCss.length} orphan CSS hashes (css=${rA.css.size} gt=${gt.css.size}) — scope id is not a deterministic function of path across realms`)
}

// Model B (fix) must be fully consistent AND structurally complete.
if (rB.orphanCss.length === 0 && rB.css.size === gt.css.size) {
  pass(`BROADCAST PATH: shared setup yields 0 orphan CSS hashes, ${rB.matched.length} matched (== ground truth ${gt.css.size})`)
} else {
  fail(`shared setup still has ${rB.orphanCss.length} orphan CSS hashes (css=${rB.css.size} gt=${gt.css.size})`)
}
// Both models must emit the SAME file set as the single-realm ground truth — this is
// what the structural test already checks, and why it stays green while WXSS is broken.
if (fileSet(modelA) !== fileSet(inline)) fail('MODEL A file set differs from ground truth (unexpected)')
else pass('MODEL A file set == ground truth (the name/length structural test can only see this, not the scope-hash linkage this content check verifies)')
if (fileSet(modelB) !== fileSet(inline)) fail('MODEL B (fix) file set differs from ground truth')
else pass('MODEL B (fix) file set == ground truth')

// Model C (real pool.js code) must be consistent + complete, and report the right appId.
if (rC.orphanCss.length === 0 && rC.css.size === gt.css.size) {
  pass(`POOL WIRING VERIFIED: src/pool.js yields 0 orphan CSS hashes, ${rC.matched.length} matched (== ground truth ${gt.css.size})`)
} else {
  fail(`src/pool.js still has ${rC.orphanCss.length} orphan CSS hashes (css=${rC.css.size} gt=${gt.css.size})`)
}
if (fileSet(modelC) !== fileSet(inline)) fail('MODEL C (pool.js) file set differs from ground truth')
else pass('MODEL C (pool.js) file set == ground truth')
if (!poolRes.appId) fail('MODEL C (pool.js) returned no appId')

console.log(failed ? '\n❌ FAIL' : '\n✅ PASS')
process.exit(failed ? 1 : 0)
