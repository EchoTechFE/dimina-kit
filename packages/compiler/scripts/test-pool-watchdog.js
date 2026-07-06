// Watchdog/liveness contract tests for the BROWSER stage pool (src/pool.js), beyond the
// basic hang/crash coverage in test-pool-worker-hardening.js:
//   - sendTimeoutMs is an INACTIVITY window, not a hard deadline: any message from the
//     worker (heartbeat / log) resets it, so a slow-but-alive worker is never killed.
//   - warmup is watchdog-guarded too (warmupTimeoutMs): a wasm toolchain load that hangs
//     must reject compile(), not leave it (and the serial compile chain) pending forever.
//   - a worker judged dead (timeout or crash) is terminate()d at judgment time, not
//     lazily on the next compile.
//   - retryOnWorkerDeath (default true): a compile attempt killed by worker death is
//     transparently retried exactly once on a fresh worker; a second death surfaces the
//     rejection (with .code preserved) and no third attempt is made.
//   - dispose() makes compile() reject, never hang.
//
// Drives the REAL src/pool.js orchestration against fake Worker-shaped objects injected
// through createWorker(), so it runs in plain Node with no build step.
import { createCompilerPool } from '../src/pool.js'

let failed = false
const chk = (cond, msg) => { if (!cond) { failed = true; console.error(`❌ ${msg}`) } else console.log(`✅ ${msg}`) }
const withTimeout = (p, ms, label) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`TIMEOUT: ${label} did not settle in ${ms}ms`)), ms)
  p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
})

const STAGES = ['logic', 'view', 'style']

// Fake Worker factory. behaviorByStage maps stage -> array of behaviors indexed by
// spawnIndex (how many times that stage slot has been (re)created); the last entry
// repeats. Behaviors:
//   'ok'             — reply like a real stage worker, immediately
//   'hang'           — never reply to setup/compile-subset (warmup replies ok)
//   'hang-warmup'    — never reply to warmup
//   'crash'          — fire onerror instead of replying to setup/compile-subset
//   'heartbeat-slow' — for setup/compile-subset: emit {type:'heartbeat'} every 50ms and
//                      only deliver the real reply after 500ms (slow but alive)
// Spawn attribution: the first STAGES.length createWorker() calls are the initial
// construction in stage order. Every later call is a respawn, and in these scenarios
// only ONE stage (the one with a non-'ok' behavior script) ever dies — so all respawn
// calls belong to that stage, with spawnIndex counting its own spawns. (A plain
// `calls % STAGES.length` would mis-attribute respawns: call 3 maps to logic, not to
// whichever stage actually died.)
function fakeWorkerFactory(behaviorByStage) {
  let calls = 0
  const byStage = { logic: [], view: [], style: [] }
  const dyingStage = STAGES.find((s) => (behaviorByStage[s] || ['ok']).some((b) => b !== 'ok')) || null
  const createWorker = () => {
    const isRespawn = calls >= STAGES.length
    const stage = isRespawn ? dyingStage : STAGES[calls]
    const spawnIndex = isRespawn ? (calls - STAGES.length + 1) : 0
    calls += 1
    const behaviors = behaviorByStage[stage] || ['ok']
    const behavior = behaviors[Math.min(spawnIndex, behaviors.length - 1)]
    const w = {
      stage,
      behavior,
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      terminated: false,
      timers: [],
      terminate() { w.terminated = true; for (const t of w.timers) clearTimeout(t) },
      postMessage(m) {
        const deliver = (data) => { if (!w.terminated && w.onmessage) w.onmessage({ data }) }
        const okReply = () => {
          if (m.type === 'warmup') return { type: 'ready', ms: 1 }
          if (m.type === 'setup') {
            return {
              type: 'setup-done',
              bundle: { appId: 'app1', name: 'demo', pages: [], storeInfo: {}, targetPath: '/work/dist' },
              scaffold: { 'app-config.json': '{}' },
            }
          }
          return { type: 'done', result: { appId: 'app1', name: 'demo', files: { [`${m.stages[0]}.out`]: 'x' } } }
        }
        if (m.type === 'warmup') {
          if (behavior === 'hang-warmup') return
          queueMicrotask(() => deliver(okReply()))
          return
        }
        if (behavior === 'hang') return
        if (behavior === 'crash') {
          queueMicrotask(() => { if (!w.terminated && w.onerror) w.onerror({ message: 'fake worker crashed', filename: 'fake-worker.js', lineno: 1 }) })
          return
        }
        if (behavior === 'heartbeat-slow') {
          for (let i = 1; i <= 9; i++) w.timers.push(setTimeout(() => deliver({ type: 'heartbeat' }), i * 50))
          w.timers.push(setTimeout(() => deliver(okReply()), 500))
          return
        }
        queueMicrotask(() => deliver(okReply()))
      },
    }
    byStage[stage].push(w)
    return w
  }
  return { createWorker, byStage }
}

const compileOutcome = (pool) =>
  pool.compile({ files: { 'app.json': '{}' } }).then(
    (r) => ({ ok: true, result: r }),
    (e) => ({ ok: false, code: e && e.code, message: String(e && e.message) }),
  )

async function main() {
// --- inactivity semantics: heartbeats keep a slow-but-alive worker off death row -----
{
  const { createWorker } = fakeWorkerFactory({ view: ['heartbeat-slow'] })
  const logs = []
  const pool = createCompilerPool({
    createWorker,
    toolchainSetupURL: 'fake://toolchain.js',
    sendTimeoutMs: 200, // < the 500ms reply latency; only liveness resets can save it
    onLog: (entry) => logs.push(entry),
  })
  const r = await withTimeout(compileOutcome(pool), 5000, 'heartbeat-slow compile()')
  chk(r.ok === true, `a worker that heartbeats every 50ms but replies after 500ms survives sendTimeoutMs=200 — the watchdog measures inactivity, not total duration (got ${r.ok ? 'ok' : r.message})`)
  chk(r.ok && Object.keys(r.result.files).length === STAGES.length + 1, `heartbeats are not FIFO-paired as replies — the compile result is still complete and correct (got ${r.ok ? JSON.stringify(Object.keys(r.result.files)) : 'rejection'})`)
  chk(logs.every((l) => l && l.message !== undefined && !/heartbeat/i.test(String(l.message))), `heartbeat messages never reach onLog (got ${logs.length} log entries)`)
  await pool.dispose()
}

// --- warmup watchdog: a hung wasm/toolchain load rejects instead of wedging forever --
{
  const { createWorker } = fakeWorkerFactory({ style: ['hang-warmup', 'ok'] })
  const pool = createCompilerPool({
    createWorker,
    toolchainSetupURL: 'fake://toolchain.js',
    sendTimeoutMs: 200,
    warmupTimeoutMs: 250,
    retryOnWorkerDeath: false, // single-attempt semantics keep this scenario's first compile a rejection
  })
  const t0 = Date.now()
  const r1 = await withTimeout(compileOutcome(pool), 5000, 'compile() against a warmup-hung worker')
  chk(r1.ok === false && r1.code === 'compiler-worker-timeout', `compile() rejects with compiler-worker-timeout when a worker never answers warmup (got ${r1.ok ? 'resolved' : r1.code}) — a hung toolchain load must not leave compile() pending forever`)
  chk(/style/.test(r1.message || ''), `the warmup timeout names the stage (got: ${r1.message})`)
  chk(Date.now() - t0 < 3000, `the warmup timeout fires on warmupTimeoutMs, promptly (${Date.now() - t0}ms)`)
  const r2 = await withTimeout(compileOutcome(pool), 5000, 'compile() after warmup-death respawn')
  chk(r2.ok === true, `the serial compile chain is NOT wedged by the earlier warmup hang — the next compile() respawns the dead worker and succeeds (got ${r2.ok ? 'ok' : r2.message})`)
  await pool.dispose()
}

// --- immediate terminate on timeout judgment (no next compile needed) ----------------
{
  const { createWorker, byStage } = fakeWorkerFactory({ view: ['hang'] })
  const pool = createCompilerPool({
    createWorker,
    toolchainSetupURL: 'fake://toolchain.js',
    sendTimeoutMs: 150,
    retryOnWorkerDeath: false,
  })
  const r = await withTimeout(compileOutcome(pool), 5000, 'compile() against a hung worker')
  chk(r.ok === false && r.code === 'compiler-worker-timeout', `compile() rejection carries .code compiler-worker-timeout (got ${r.code}) so downstream fallbacks can key off worker death`)
  chk(/view/.test(r.message || ''), `the timeout rejection names the stage (got: ${r.message})`)
  chk(byStage.view[0].terminated === true, 'the wedged worker is terminate()d the instant the timeout is judged — a busy-looping wasm worker must not keep burning a core until the next compile happens to come along')
  await pool.dispose()
}

// --- immediate terminate on crash judgment -------------------------------------------
{
  const { createWorker, byStage } = fakeWorkerFactory({ logic: ['crash'] })
  const pool = createCompilerPool({
    createWorker,
    toolchainSetupURL: 'fake://toolchain.js',
    sendTimeoutMs: 200,
    retryOnWorkerDeath: false,
  })
  const r = await withTimeout(compileOutcome(pool), 5000, 'compile() against a crashing worker')
  chk(r.ok === false && r.code === 'compiler-worker-crashed', `compile() rejection carries .code compiler-worker-crashed (got ${r.code})`)
  chk(byStage.logic[0].terminated === true, 'a crashed worker is terminate()d at crash judgment time, releasing whatever is left of it immediately')
  await pool.dispose()
}

// --- retryOnWorkerDeath default: one transparent retry rescues a transient death -----
{
  const { createWorker, byStage } = fakeWorkerFactory({ view: ['hang', 'ok'] })
  const pool = createCompilerPool({
    createWorker,
    toolchainSetupURL: 'fake://toolchain.js',
    sendTimeoutMs: 150,
    // retryOnWorkerDeath defaults to true
  })
  const r = await withTimeout(compileOutcome(pool), 8000, 'compile() with default retry')
  chk(r.ok === true, `a compile attempt killed by a transient worker death is transparently retried and succeeds — the caller never sees the death (got ${r.ok ? 'ok' : `${r.code}: ${r.message}`})`)
  chk(r.ok && Object.keys(r.result.files).length === STAGES.length + 1, `the retried attempt produces the full merged result (got ${r.ok ? JSON.stringify(Object.keys(r.result.files)) : 'rejection'})`)
  chk(byStage.view.length === 2, `the dead stage was respawned exactly once for the retry (spawned ${byStage.view.length} view workers)`)
  await pool.dispose()
}

// --- retry also covers warmup deaths --------------------------------------------------
{
  const { createWorker } = fakeWorkerFactory({ style: ['hang-warmup', 'ok'] })
  const pool = createCompilerPool({
    createWorker,
    toolchainSetupURL: 'fake://toolchain.js',
    sendTimeoutMs: 200,
    warmupTimeoutMs: 250,
  })
  const r = await withTimeout(compileOutcome(pool), 8000, 'compile() with default retry across a warmup death')
  chk(r.ok === true, `the transparent retry replays the whole attempt including warmup, so a one-off warmup hang is invisible to the caller (got ${r.ok ? 'ok' : `${r.code}: ${r.message}`})`)
  await pool.dispose()
}

// --- retry is exactly once: a second death surfaces, no third attempt ----------------
{
  const { createWorker, byStage } = fakeWorkerFactory({ view: ['hang', 'hang', 'ok'] })
  const pool = createCompilerPool({
    createWorker,
    toolchainSetupURL: 'fake://toolchain.js',
    sendTimeoutMs: 150,
  })
  const r = await withTimeout(compileOutcome(pool), 8000, 'compile() with two consecutive deaths')
  chk(r.ok === false && r.code === 'compiler-worker-timeout', `when the retry attempt dies too, compile() rejects and preserves the worker-death code (got ${r.ok ? 'resolved' : r.code})`)
  chk(byStage.view.length === 2, `exactly one retry: two view workers were ever spawned for this compile, a third attempt is not made (spawned ${byStage.view.length})`)
  await pool.dispose()
}

// --- retryOnWorkerDeath: false restores single-attempt semantics ---------------------
{
  const { createWorker, byStage } = fakeWorkerFactory({ view: ['hang', 'ok'] })
  const pool = createCompilerPool({
    createWorker,
    toolchainSetupURL: 'fake://toolchain.js',
    sendTimeoutMs: 150,
    retryOnWorkerDeath: false,
  })
  const r = await withTimeout(compileOutcome(pool), 5000, 'compile() with retry disabled')
  chk(r.ok === false && r.code === 'compiler-worker-timeout', `with retryOnWorkerDeath:false the first death rejects compile() immediately (got ${r.ok ? 'resolved' : r.code})`)
  chk(byStage.view.length === 1, `no respawn happens within the failed compile when retry is disabled (spawned ${byStage.view.length})`)
  await pool.dispose()
}

// --- dispose(): compile() after dispose rejects, never hangs -------------------------
{
  const { createWorker } = fakeWorkerFactory({})
  const pool = createCompilerPool({ createWorker, toolchainSetupURL: 'fake://toolchain.js' })
  await pool.dispose()
  const r = await withTimeout(compileOutcome(pool), 3000, 'compile() after dispose()')
  chk(r.ok === false, `compile() on a disposed pool rejects instead of hanging (got ${r.ok ? 'resolved' : `${r.code}`})`)
  chk(r.code === 'compiler-pool-disposed', `the rejection identifies disposal, not a worker fault (got ${r.code})`)
}

console.log(failed ? '\n❌ FAIL' : '\n✅ PASS: inactivity watchdog, warmup guard, immediate terminate, one-shot retry and dispose all hold')
}

// Set exitCode (not process.exit()) so the event loop drains and stdout flushes before
// the process ends — process.exit() right after console.log can truncate piped output.
main().then(
  () => { process.exitCode = failed ? 1 : 0 },
  (err) => { console.error('❌ FAIL (uncaught):', err); process.exitCode = 1 },
)
