// Lazy per-stage toolchain loading contract for the resident Node worker_threads
// pool (dist/pool.node.js). Today compile-core.js imports the logic/view/style
// compilers (and therefore their heavy deps) all at once, so every realm — the
// main thread AND each stage worker — eagerly loads the full dmcc toolchain
// regardless of which stage that realm actually runs. This guards the target
// contract instead:
//   - the main thread never loads any HEAVY package after a full build.
//   - the logic worker loads esbuild + oxc-parser, never sass/cssnano/less/
//     @vue/compiler-sfc.
//   - the view worker loads @vue/compiler-sfc, never sass/cssnano/less.
//   - the style worker loads sass, never esbuild/oxc-parser.
//
// The probe reads each realm's CJS require cache, so only packages with a CJS
// footprint are observable: cheerio resolves pure-ESM and never appears there
// (in any realm, loaded or not), so the boundaries are asserted through the
// cache-visible packages instead. oxc-parser is cache-visible via its native
// @oxc-parser/* binding, which the introspect reply reports under its name.
//   - a worker preloads its OWN stage's toolchain at spawn time, before any
//     build ever runs — a cold pool is already narrowed by stage identity, not
//     just by "what got compiled so far".
//
// Drives this through a new introspect protocol message ({ type: 'introspect' })
// that a stage worker must answer with { type: 'introspect', loaded: string[] },
// listing which HEAVY packages are present in ITS OWN require cache.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const APP = process.env.TEST_PROJECT
  || fileURLToPath(new URL('../../../dimina/fe/example/base', import.meta.url))
const TMP = fileURLToPath(new URL('../.tmp-lazy-toolchain/', import.meta.url))
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
const dir = (n) => path.join(TMP, n)

// require-cache keys resolve to absolute file paths; a HEAVY package's own
// files always sit under a `node_modules/<name>/` segment (scoped packages
// keep their slash inside that one segment, e.g. node_modules/@vue/compiler-sfc/).
const heavyHit = (cacheKeys, name) => cacheKeys.some((k) => k.includes(`node_modules/${name}/`))

let failed = false
const chk = (cond, msg) => { if (!cond) { failed = true; console.error(`❌ ${msg}`) } else console.log(`✅ ${msg}`) }
const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT: ${label} did not settle in ${ms}ms`)), ms).unref()),
])

const { createNodeCompilerPool } = await import('../dist/pool.node.js')

const introspect = (slot) => slot.request({ type: 'introspect' }, { timeoutMs: 10000, description: 'introspect' })
const slotFor = (pool, stage) => pool._slots.find((x) => x.stage === stage).slot

const pools = []
function makePool(opts) {
  const p = createNodeCompilerPool(opts)
  pools.push(p)
  return p
}

// --- condition 1: main realm stays free of every HEAVY package after a real build ---
const pool = makePool()
const info = await withTimeout(pool.build(dir('a1'), APP, true, {}), 60000, 'baseline build')
chk(!!info.appId, `baseline build ok (appId ${info.appId})`)

const req = createRequire(import.meta.url)
const mainCacheKeys = Object.keys(req.cache || {})
const MAIN_REALM_HEAVY = ['sass', 'cssnano', 'less', 'autoprefixer', 'cheerio', '@vue/compiler-sfc', 'oxc-parser', 'esbuild']
for (const h of MAIN_REALM_HEAVY) {
  chk(!heavyHit(mainCacheKeys, h), `main realm require cache stays free of ${h} after a full build`)
}

// --- condition 2/3: per-stage worker introspect after that same real build ----------
const loaded = {}
for (const stage of pool.stages) {
  const reply = await withTimeout(introspect(slotFor(pool, stage)), 10000, `introspect(${stage})`)
  chk(reply && reply.type === 'introspect' && Array.isArray(reply.loaded),
    `${stage} worker answers introspect with { type:'introspect', loaded:[...] } (got ${JSON.stringify(reply)})`)
  loaded[stage] = (reply && reply.loaded) || []
}

const notLoaded = (stage, name) => chk(!loaded[stage].includes(name),
  `${stage} worker has NOT loaded ${name} (loaded: ${JSON.stringify(loaded[stage])})`)
const isLoaded = (stage, name) => chk(loaded[stage].includes(name),
  `${stage} worker HAS loaded ${name} (loaded: ${JSON.stringify(loaded[stage])})`)

for (const name of ['sass', 'cssnano', 'less', '@vue/compiler-sfc']) notLoaded('logic', name)
isLoaded('logic', 'esbuild')
isLoaded('logic', 'oxc-parser')

for (const name of ['sass', 'cssnano', 'less']) notLoaded('view', name)
isLoaded('view', '@vue/compiler-sfc')

isLoaded('style', 'sass')
notLoaded('style', 'esbuild')
notLoaded('style', 'oxc-parser')

// --- condition 4: a freshly spawned pool preloads by stage identity, before any build ---
const coldPool = makePool()
const deadline = Date.now() + 10000
let styleSawSass = false
let logicSawSass = false
while (Date.now() < deadline && !styleSawSass) {
  const styleSlot = slotFor(coldPool, 'style')
  const logicSlot = slotFor(coldPool, 'logic')
  const [styleReply, logicReply] = await Promise.all([
    styleSlot.ensureAlive().then(() => introspect(styleSlot)).catch(() => null),
    logicSlot.ensureAlive().then(() => introspect(logicSlot)).catch(() => null),
  ])
  if (styleReply && Array.isArray(styleReply.loaded) && styleReply.loaded.includes('sass')) styleSawSass = true
  if (logicReply && Array.isArray(logicReply.loaded) && logicReply.loaded.includes('sass')) logicSawSass = true
  if (!styleSawSass) await new Promise((r) => setTimeout(r, 200))
}
chk(styleSawSass, 'a cold pool (no build yet) preloads sass into the style worker within 10s, by stage identity alone')
chk(!logicSawSass, 'the logic worker never loads sass, even while the cold pool warms up')

// --- teardown -------------------------------------------------------------------------
await Promise.all(pools.map((p) => p.dispose()))
fs.rmSync(TMP, { recursive: true, force: true })
console.log(failed ? '\n❌ FAIL' : '\n✅ PASS: main realm purity + per-stage toolchain boundaries + spawn-time identity preload')
process.exit(failed ? 1 : 0)
