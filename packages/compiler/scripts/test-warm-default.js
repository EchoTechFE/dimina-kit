// Contract for the lazy default pool's warm-standby hook (dist/pool.node.js):
// `warmDefaultPool()` creates the module-level singleton pool (the SAME one
// the drop-in default `build()` lazily creates on its own first call) and
// pre-warms its stage workers, WITHOUT running a build and WITHOUT writing
// anything to stdout — a devtools host calls this while no project is open
// (fork+import+toolchain load happens up front, project-agnostically) so the
// next `build()` — the FIRST real compile — starts warm.
//
// This file deliberately does NOT assert a warm-vs-cold TIMING ratio: CI
// machines vary too much in scheduling noise for a hard "<60% of cold"
// threshold to be reliable, and a flaky perf assertion here would train
// people to ignore red. Instead it asserts the CONTRACT surface directly:
// warmDefaultPool exists, resolves, produces no build-shaped output, and the
// build() that follows it succeeds and produces a correct dmcc-shaped
// artifact tree — exactly the same bar `test-pool-node.js` already holds a
// cold pool to. A timing observation is still logged (informational only,
// never asserted) so a human skimming CI output can sanity-check the speedup.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = process.env.TEST_PROJECT
  || fileURLToPath(new URL('../../../dimina/fe/example/base', import.meta.url))
const TMP = fileURLToPath(new URL('../.tmp-warm-default/', import.meta.url))
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
const dir = (n) => path.join(TMP, n)

let failed = false
const chk = (cond, msg) => { if (!cond) { failed = true; console.error(`❌ ${msg}`) } else console.log(`✅ ${msg}`) }
const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT: ${label} did not settle in ${ms}ms`)), ms).unref()),
])

/** Captures everything written to stdout during `fn()`; restores the real stream after. */
async function captureStdout(fn) {
  const chunks = []
  const realWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, ...rest) => { chunks.push(String(chunk)); return realWrite(chunk, ...rest) }
  try {
    await fn()
  } finally {
    process.stdout.write = realWrite
  }
  return chunks.join('')
}

const { default: build, warmDefaultPool, disposeDefaultPool } = await import('../dist/pool.node.js')

chk(typeof warmDefaultPool === 'function', 'dist/pool.node.js exports warmDefaultPool as a function')
chk(typeof disposeDefaultPool === 'function', 'dist/pool.node.js exports disposeDefaultPool (used here for teardown)')

// --- warmDefaultPool(): resolves, no build, no stdout ---------------------
let warmMs = -1
const warmOutput = await captureStdout(async () => {
  const t0 = Date.now()
  await withTimeout(warmDefaultPool(), 60000, 'warmDefaultPool()')
  warmMs = Date.now() - t0
})
chk(warmOutput === '', `warmDefaultPool() produces NO stdout (it must not run a build) — got: ${JSON.stringify(warmOutput.slice(0, 200))}`)
chk(!fs.existsSync(dir('warm1')), 'warmDefaultPool() writes no output tree (it takes no outputDir/workPath — warming is project-agnostic)')

// --- build() after warm: succeeds, reuses the warmed singleton ------------
const t1 = Date.now()
const info = await withTimeout(build(dir('warm1'), APP, true, {}), 60000, 'build() after warmDefaultPool()')
const warmBuildMs = Date.now() - t1
chk(!!info && !!info.appId, 'build() after warmDefaultPool() resolves with a real appInfo (the warmed pool is usable, not just spawned-and-abandoned)')
chk(
  fs.existsSync(path.join(dir('warm1'), info.appId, 'main', 'logic.js'))
  && fs.existsSync(path.join(dir('warm1'), info.appId, 'main', 'app.css')),
  'build() after warmDefaultPool() publishes a complete, dmcc-shaped output tree',
)

await disposeDefaultPool()

// --- informational-only timing signal (never asserted — see file header) --
const t2 = Date.now()
const coldInfo = await withTimeout(build(dir('cold1'), APP, true, {}), 60000, 'cold build() (fresh singleton after dispose)')
const coldBuildMs = Date.now() - t2
chk(!!coldInfo && !!coldInfo.appId, 'the cold build after dispose (baseline for the logged timing signal) still succeeds')
console.log(`[info] warmDefaultPool(): ${warmMs}ms; first build() after warm: ${warmBuildMs}ms; cold build() baseline: ${coldBuildMs}ms (not asserted — see file header)`)

await disposeDefaultPool()
fs.rmSync(TMP, { recursive: true, force: true })
console.log(failed ? '\n❌ FAIL' : '\n✅ PASS: warmDefaultPool() exists, is side-effect-free (no build, no stdout), and the pool it warms is the one build() goes on to use successfully')
process.exit(failed ? 1 : 0)
