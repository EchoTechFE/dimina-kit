// Robustness tests for the BROWSER stage pool (src/pool.js): a stage worker that hangs
// (never replies) or crashes (throws / fires onerror) must NOT wedge compile() forever.
// Before this test existed, worker.send() was a bare postMessage()+await-resolve with no
// timeout, so a wedged/dead worker left compile()'s promise pending forever — the
// downstream compile@1 in dimina-web-client only catches rejection, not permanent
// pending, so the whole compile chain would silently freeze with no fallback triggered.
//
// This drives the REAL src/pool.js orchestration (no browser globals used there) against
// fake `Worker`-shaped objects injected through createWorker(), so it runs in plain Node
// with no build step and no real Worker/browser environment required.
import { createCompilerPool } from '../src/pool.js'

let failed = false
const chk = (cond, msg) => { if (!cond) { failed = true; console.error(`❌ ${msg}`) } else console.log(`✅ ${msg}`) }
// Race p against a watchdog timeout, but always settle (and clear) the timer once p
// settles — a bare Promise.race([p, timeoutPromise]) leaves the timeout branch's promise
// permanently unsettled once p wins, which Node's unsettled-top-level-await diagnostic
// (flags at process exit) correctly complains about.
const withTimeout = (p, ms, label) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`TIMEOUT: ${label} did not settle in ${ms}ms`)), ms)
  p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
})

const STAGES = ['logic', 'view', 'style']

// A fake Worker: postMessage() is driven by `behavior`, which can change across
// respawns (spawnIndex counts how many times THIS stage slot has been (re)created).
function fakeWorkerFactory(behaviorByStage) {
  // createCompilerPool's createWorker is a bare () => Worker with no stage argument
  // (real stage assignment happens over postMessage, not at construction) — so we infer
  // "which spawn this is" purely from call order: the first STAGES.length calls are the
  // initial construction (logic, view, style in array order); any call after that is a
  // respawn of whichever entry died, and in these tests only one entry ever dies, so the
  // (N % STAGES.length)th call after the first pass maps back to the same stage slot.
  let calls = 0
  return function createWorker() {
    const stage = STAGES[calls % STAGES.length]
    const spawnIndex = Math.floor(calls / STAGES.length) // 0 = initial, 1 = first respawn, ...
    calls += 1
    const behaviors = behaviorByStage[stage] || ['ok']
    const behavior = behaviors[Math.min(spawnIndex, behaviors.length - 1)]

    const w = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      terminated: false,
      terminate() { w.terminated = true },
      postMessage(m) {
        // 'warmup' is intentionally never subject to the configured hang/crash behavior:
        // pool.js's send() exempts warmup from the timeout by design (see src/pool.js),
        // so a fake worker that hung on warmup would hang forever for a reason that has
        // nothing to do with what this test is exercising (setup/compile-subset).
        if (m.type !== 'warmup') {
          if (behavior === 'hang') return // never reply -> exercises the send() timeout
          if (behavior === 'crash') {
            queueMicrotask(() => {
              if (w.onerror) w.onerror({ message: 'fake worker crashed', filename: 'fake-worker.js', lineno: 1 })
            })
            return
          }
        }
        // 'ok' — respond like a real stage-worker.js would, minimally.
        queueMicrotask(() => {
          let resp
          if (m.type === 'warmup') resp = { type: 'ready', ms: 1 }
          else if (m.type === 'setup') {
            resp = {
              type: 'setup-done',
              bundle: { appId: 'app1', name: 'demo', pages: [], storeInfo: {}, targetPath: '/work/dist' },
              scaffold: { 'app-config.json': '{}' },
            }
          } else if (m.type === 'compile-subset') {
            resp = { type: 'done', result: { appId: 'app1', name: 'demo', files: { [`${m.stages[0]}.out`]: 'x' } } }
          }
          if (w.onmessage) w.onmessage({ data: resp })
        })
      },
    }
    return w
  }
}

// Everything below runs inside main() rather than at the top level: Node's
// unsettled-top-level-await diagnostic can misfire (observed on Node 24.4.1) against
// literal top-level `await` expressions racing a watchdog timer, even when every promise
// genuinely settles — wrapping in a plain async function sidesteps it.
async function main() {
// --- scenario A: a hung worker must time out, not wedge compile() forever ----------
{
  const createWorker = fakeWorkerFactory({ view: ['hang', 'ok'] }) // 1st spawn hangs, respawn is ok
  const pool = createCompilerPool({
    createWorker,
    toolchainSetupURL: 'fake://toolchain.js',
    sendTimeoutMs: 200, // short, so the test doesn't wait 30s
  })

  const t0 = Date.now()
  const r1 = await withTimeout(
    pool.compile({ files: { 'app.json': '{}' } }).then(() => 'resolved', (e) => e.message),
    5000,
    'compile() against a hung worker',
  )
  const elapsed = Date.now() - t0
  chk(/timed out/.test(String(r1)) && /view/.test(String(r1)), `compile() rejects (not hangs) on a hung worker: ${r1}`)
  chk(elapsed < 2000, `compile() settled promptly (${elapsed}ms) instead of hanging until an external watchdog`)

  const r2 = await withTimeout(
    pool.compile({ files: { 'app.json': '{}' } }).then(() => 'resolved', (e) => e.message),
    5000,
    'compile() after respawn',
  )
  chk(r2 === 'resolved', `next compile() succeeds after lazy respawn of the dead worker: ${r2}`)
  await pool.dispose()
}

// --- scenario B: a crashing worker (onerror) must also fail fast, then recover -----
{
  const createWorker = fakeWorkerFactory({ logic: ['crash', 'ok'] }) // 1st spawn crashes, respawn is ok
  const pool = createCompilerPool({
    createWorker,
    toolchainSetupURL: 'fake://toolchain.js',
    sendTimeoutMs: 200,
  })

  const r1 = await withTimeout(
    pool.compile({ files: { 'app.json': '{}' } }).then(() => 'resolved', (e) => e.message),
    5000,
    'compile() against a crashing worker',
  )
  chk(/worker error/.test(String(r1)) || /crashed/.test(String(r1)), `compile() rejects on a crashing worker: ${r1}`)

  const r2 = await withTimeout(
    pool.compile({ files: { 'app.json': '{}' } }).then(() => 'resolved', (e) => e.message),
    5000,
    'compile() after respawn (crash)',
  )
  chk(r2 === 'resolved', `next compile() succeeds after lazy respawn of the crashed worker: ${r2}`)
  await pool.dispose()
}

// --- normal path: an all-'ok' pool is unaffected by the timeout machinery ----------
{
  const createWorker = fakeWorkerFactory({}) // every stage defaults to 'ok'
  const pool = createCompilerPool({ createWorker, toolchainSetupURL: 'fake://toolchain.js' }) // default 30s timeout
  const r = await withTimeout(pool.compile({ files: { 'app.json': '{}' } }), 5000, 'normal compile()')
  chk(r && r.appId === 'app1' && Object.keys(r.files).length === STAGES.length + 1, // 3 stage outs + app-config.json
    `normal compile() is unaffected by the timeout/respawn machinery: ${JSON.stringify(Object.keys(r.files))}`)
  await pool.dispose()
}

console.log(failed ? '\n❌ FAIL' : '\n✅ PASS: hung/crashed stage workers time out and lazily respawn without wedging compile()')
}

// Set exitCode (not process.exit()) so the event loop drains and stdout/stderr flush
// before the process ends — process.exit() right after console.log can truncate output
// when stdout is piped (as it is under a test harness / captured shell), a well-known
// Node gotcha (nodejs/node#6379).
main().then(
  () => { process.exitCode = failed ? 1 : 0 },
  (err) => { console.error('❌ FAIL (uncaught):', err); process.exitCode = 1 },
)
