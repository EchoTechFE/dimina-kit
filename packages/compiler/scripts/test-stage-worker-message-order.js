// Message-ordering contract for the resident Node worker_threads pool
// (dist/pool.node.js): a stage worker processes every message that produces
// a reply in arrival order. An introspect request sent while a build is
// in flight on the same stage must have its reply matched to the introspect
// itself, never to the in-flight build's done/error — the worker's FIFO
// reply queue must stay aligned with the order requests actually arrived in,
// not with whichever message happens to finish generating a reply first.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = process.env.TEST_PROJECT
  || fileURLToPath(new URL('../../../dimina/fe/example/base', import.meta.url))
const TMP = fileURLToPath(new URL('../.tmp-stage-worker-message-order/', import.meta.url))
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
const dir = (n) => path.join(TMP, n)

let failed = false
const chk = (cond, msg) => { if (!cond) { failed = true; console.error(`❌ ${msg}`) } else console.log(`✅ ${msg}`) }
const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT: ${label} did not settle in ${ms}ms`)), ms).unref()),
])

const { createNodeCompilerPool } = await import('../dist/pool.node.js')
const slotFor = (pool, stage) => pool._slots.find((x) => x.stage === stage).slot
const introspect = (slot) => slot.request({ type: 'introspect' }, { timeoutMs: 15000, description: 'mid-build introspect' })

const pools = []
function makePool(opts) {
  const p = createNodeCompilerPool(opts)
  pools.push(p)
  return p
}

// Attacks the race up to a few times: the mid-build introspect must land
// while the logic stage worker is still busy with the build message, which
// depends on scheduling timing that can occasionally miss on a fast machine.
const ATTEMPTS = 3
let sawMisroutedReply = false
let lastBuildInfo = null
let lastIntrospectReply = null

for (let attempt = 1; attempt <= ATTEMPTS && !sawMisroutedReply; attempt += 1) {
  const pool = makePool()

  // warm baseline: prove a normal build completes cleanly before racing it
  const baseline = await withTimeout(pool.build(dir(`warm${attempt}`), APP, true, {}), 60000, `warm baseline build (attempt ${attempt})`)
  chk(!!baseline.appId, `attempt ${attempt}: warm baseline build completes (appId ${baseline.appId})`)

  const logicSlot = slotFor(pool, 'logic')
  const buildPromise = withTimeout(pool.build(dir(`race${attempt}`), APP, true, {}), 60000, `racing build (attempt ${attempt})`)
  await new Promise((r) => setTimeout(r, 50))

  const introspectPromise = withTimeout(introspect(logicSlot), 15000, `mid-build introspect (attempt ${attempt})`)

  const [buildInfo, introspectReply] = await Promise.all([buildPromise, introspectPromise])
  lastBuildInfo = buildInfo
  lastIntrospectReply = introspectReply

  chk(!!buildInfo.appId, `attempt ${attempt}: racing build still resolves with a normal appId (got ${JSON.stringify(buildInfo)})`)

  if (!introspectReply || introspectReply.type !== 'introspect') {
    sawMisroutedReply = true
    console.error(`❌ attempt ${attempt}: mid-build introspect request received a non-introspect reply instead of being queued after the in-flight build (got ${JSON.stringify(introspectReply)})`)
  } else {
    console.log(`✅ attempt ${attempt}: mid-build introspect received its own { type: 'introspect' } reply`)
  }
}

chk(!sawMisroutedReply,
  `every attempt's mid-build introspect reply matched the introspect request itself, never the in-flight build's reply (last build info: ${JSON.stringify(lastBuildInfo)}, last introspect reply: ${JSON.stringify(lastIntrospectReply)})`)

// --- teardown -------------------------------------------------------------------------
await Promise.all(pools.map((p) => p.dispose().catch(() => {})))
fs.rmSync(TMP, { recursive: true, force: true })
console.log(failed ? '\n❌ FAIL' : '\n✅ PASS: stage worker replies stay FIFO-aligned to request arrival order under concurrent build + introspect traffic')
process.exit(failed ? 1 : 0)
