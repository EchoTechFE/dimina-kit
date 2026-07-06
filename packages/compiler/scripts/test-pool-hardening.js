// Robustness tests for the resident Node disk pool (dist/pool.node.js):
//   • a dead stage worker must NOT wedge later builds — postMessage to an exited
//     worker neither throws nor answers, so without respawn the next build hangs
//     forever (idle death AND mid-build death both covered)
//   • builds from TWO pool instances must serialize — setupCompile/publishToDist
//     go through dmcc's process-global env singletons, so cross-instance overlap
//     would publish one pool's staging dir under the other's appId
//   • build() after dispose() rejects instead of silently respawning workers
// Worker termination reaches the live Worker via the `_slots` test hook.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const APP = process.env.APP_DIR
  || fileURLToPath(new URL('../../../dimina/fe/example/base', import.meta.url))
const TMP = fileURLToPath(new URL('../.tmp-pool-hardening/', import.meta.url))
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
const dir = (n) => path.join(TMP, n)

const { createNodeCompilerPool } = await import('../dist/pool.node.js')

let failed = false
const chk = (cond, msg) => { if (!cond) { failed = true; console.error(`❌ ${msg}`) } else console.log(`✅ ${msg}`) }
const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT: ${label} did not settle in ${ms}ms`)), ms).unref()),
])

// --- idle-death recovery: kill a warm worker, next build must succeed --------
// retryOnWorkerDeath is off for this pool: the mid-build scenario below asserts
// single-attempt rejection semantics (transparent retry has its own scenario).
const pool = createNodeCompilerPool({ retryOnWorkerDeath: false })
const info1 = await pool.build(dir('a1'), APP, true, {})
chk(!!info1.appId, `baseline build ok (appId ${info1.appId}, path ${info1.path})`)
await pool._slots[1].w.terminate() // kill the view worker while idle
const info2 = await withTimeout(pool.build(dir('a2'), APP, true, {}), 120000, 'build after idle worker death')
chk(info2.appId === info1.appId && fs.existsSync(path.join(dir('a2'), info2.appId, 'main', 'logic.js')),
  'build after idle worker death succeeds via respawn (no hang)')

// --- mid-build death: in-flight build fails fast, NEXT build recovers --------
const midBuild = pool.build(dir('b1'), APP, true, {})
setTimeout(() => { pool._slots[0].w?.terminate() }, 30) // kill logic worker mid-flight
const midResult = await withTimeout(midBuild.then(() => 'resolved', (e) => e.message), 120000, 'mid-flight-death build')
chk(/exited/.test(String(midResult)), `mid-flight worker death rejects the build with the stage error: ${midResult}`)
const info3 = await withTimeout(pool.build(dir('b2'), APP, true, {}), 120000, 'build after mid-flight death')
chk(info3.appId === info1.appId, 'next build after mid-flight death succeeds via respawn')

const treeOk = (d, i) => fs.existsSync(path.join(d, i.appId, 'main', 'logic.js')) && fs.existsSync(path.join(d, i.appId, 'main', 'app.css'))

// --- transparent retry: a mid-build worker death is invisible to the caller ---
const poolR = createNodeCompilerPool() // retryOnWorkerDeath defaults to true
const retryBuild = poolR.build(dir('r1'), APP, true, {})
setTimeout(() => { poolR._slots[0].w?.terminate() }, 30) // kill logic worker mid-flight
const retryInfo = await withTimeout(retryBuild, 240000, 'mid-flight-death build with retry')
chk(retryInfo && retryInfo.appId === info1.appId && treeOk(dir('r1'), retryInfo),
  'a mid-build worker death is transparently retried once and the build still publishes intact output')
await poolR.dispose()

// --- two pool instances, concurrent builds → module-level serialization ------
const poolB = createNodeCompilerPool()
const [x, y] = await withTimeout(
  Promise.all([pool.build(dir('c1'), APP, true, {}), poolB.build(dir('c2'), APP, true, {})]),
  240000, 'cross-pool concurrent builds',
)
chk(x.appId === y.appId && treeOk(dir('c1'), x) && treeOk(dir('c2'), y),
  'concurrent builds from two pool instances both publish intact output (serialized)')

// --- dispose semantics --------------------------------------------------------
await poolB.dispose()
const afterDispose = await poolB.build(dir('d1'), APP, true, {}).then(() => 'resolved', (e) => e.message)
chk(/disposed/.test(String(afterDispose)), `build after dispose rejects: ${afterDispose}`)
await pool.dispose()

fs.rmSync(TMP, { recursive: true, force: true })
console.log(failed ? '\n❌ FAIL' : '\n✅ PASS: respawn-on-death, cross-pool serialization, dispose guard')
process.exit(failed ? 1 : 0)
