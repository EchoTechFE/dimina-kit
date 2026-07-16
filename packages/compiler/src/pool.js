// Orchestrated compile pool — the "batteries-included" export. The downstream calls
// createCompilerPool(...).compile(source) and gets the merged build back; the pool
// owns ALL the orchestration the downstream used to hand-write:
//   - a resident worker per stage, kept warm so the wasm toolchain loads ONCE
//   - dmcc-consistent stage-level parallelism (logic | view | style each in a realm)
//   - realm reuse across compiles (resetCompilerState inside the worker)
//   - dispatch + disjoint-output merge
//
// Worker supervision (inactivity watchdog, immediate terminate on death, generation
// guard against stale replies, terminate-ack-gated respawn) lives in src/worker-slot.js
// — this file only describes how to spawn a browser Worker and what the compile
// protocol looks like. A compile attempt killed by worker death (timeout/crash) is
// transparently retried exactly once on a fresh worker (retryOnWorkerDeath).
//
// What stays with the downstream is only what is genuinely host-specific:
//   - createWorker(): how to spawn a module Worker running this package's stage worker
//     (bundler/hosting-specific — one line)
//   - toolchainSetupURL: an ESM the worker imports to install the two wasm hooks
//     (esbuild.wasm / oxc wasm are host-hosted assets)
//   - the source itself (a { relPath: content } map). OPFS is intentionally NOT here:
//     it's an optional zero-copy source-distribution the downstream can layer on.
import { createWorkerSlot, settleAll } from './worker-slot.js'

const DEFAULT_STAGES = ['logic', 'view', 'style']

// Default INACTIVITY ceiling for a setup/compile-subset round trip. The stage worker
// heartbeats while it works, so any sign of life resets this window — it only expires
// after that much total silence, which for a live worker means it is truly wedged
// (e.g. a synchronous wasm loop blocking its event loop). Without it, a stuck worker
// would leave compile() (and the downstream fallback keyed off its rejection) pending
// forever.
const DEFAULT_SEND_TIMEOUT_MS = 30000

// Warmup gets its own, longer window: a cold wasm-toolchain fetch (~13MB) can
// legitimately dwarf a compile step, but a hung toolchain import must STILL reject
// eventually — an unguarded warmup would wedge the serial compile chain forever.
const DEFAULT_WARMUP_TIMEOUT_MS = 120000

const WORKER_DEATH_CODES = new Set(['compiler-worker-timeout', 'compiler-worker-crashed', 'compiler-worker-dead'])

/**
 * @param {{
 *   createWorker: () => Worker,     // required: spawn a module worker running dist/stage-worker.browser.js
 *   toolchainSetupURL: string,      // required: ESM URL that installs __esbuildTransform/__oxcParseSync in the worker
 *   stages?: string[],              // default ['logic','view','style']
 *   workPath?: string,              // default '/work'
 *   onLog?: (entry: { level: string, message: string }) => void,  // worker console diagnostics
 *   sendTimeoutMs?: number,         // default 30000 — inactivity window per setup/compile-subset round trip
 *   warmupTimeoutMs?: number,       // default 120000 — inactivity window for the warmup round trip
 *   retryOnWorkerDeath?: boolean,   // default true — one transparent whole-attempt retry after a worker death
 * }} options
 */
export function createCompilerPool(options = {}) {
  const {
    createWorker,
    toolchainSetupURL,
    stages = DEFAULT_STAGES,
    workPath: defaultWorkPath = '/work',
    onLog,
    sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS,
    warmupTimeoutMs = DEFAULT_WARMUP_TIMEOUT_MS,
    retryOnWorkerDeath = true,
  } = options
  if (typeof createWorker !== 'function') {
    throw new Error('[compiler] createCompilerPool: options.createWorker (() => Worker) is required')
  }
  if (!toolchainSetupURL) {
    throw new Error('[compiler] createCompilerPool: options.toolchainSetupURL is required')
  }

  let disposed = false

  const workers = stages.map((stage) => {
    const name = `[compiler] stage '${stage}' worker`
    const slot = createWorkerSlot({
      name,
      spawnTransport: ({ onMessage, onCrash }) => {
        const w = createWorker()
        w.onmessage = (e) => onMessage(e.data)
        w.onerror = (ev) => {
          // Worker-script-level failure (module load / uncaught). ErrorEvent.message is
          // often empty for these — surface filename:lineno and a hint so it's not a
          // bare "error".
          const msg = (ev && (ev.message || (ev.error && ev.error.message)))
            || 'worker failed to load or threw (no message — often a module-load / static-asset / cross-origin failure)'
          const where = ev && ev.filename ? ` (${ev.filename}:${ev.lineno || 0})` : ''
          onCrash(`${name} error: ${msg}${where}`)
        }
        w.onmessageerror = () => {
          onCrash(`${name} sent an unstructured-clonable message (onmessageerror)`)
        }
        return { postMessage: (m) => w.postMessage(m), terminate: () => w.terminate() }
      },
      onEvent: (d) => {
        // Diagnostics the compiler logs inside the worker (missing components,
        // unsupported wx APIs, style-preprocessor fallbacks, …) arrive as out-of-band
        // { type:'log' } messages — surface them via onLog instead of pairing them
        // with a request reply.
        if (d && d.type === 'log') {
          if (onLog) { try { onLog({ level: d.level, message: d.message, stage }) } catch { /* ignore */ } }
          return true
        }
        // Heartbeats exist purely as liveness for the slot's inactivity watchdog.
        if (d && d.type === 'heartbeat') return true
        return false
      },
    })
    const entry = { stage, slot, warmed: null, warmedGen: 0 }
    // Spawn eagerly so the pool is warm from creation; a spawn failure surfaces on the
    // first compile()'s own ensureAlive rather than as an unhandled rejection here.
    slot.ensureAlive().catch(() => {})
    return entry
  })

  // Sends a protocol message and normalizes the worker's own { type:'error' } replies
  // (real compile errors — message + stack from inside the worker) into throws. Worker
  // DEATH (timeout/crash) instead arrives as a coded rejection from the slot.
  async function requestChecked(entry, msg, description, timeoutMs) {
    const r = await entry.slot.request(msg, { timeoutMs, description })
    if (!r || r.type === 'error') {
      // Stable classification for downstream: worker-reported compile/setup errors get
      // their own code, distinct from the worker-death codes that gate the retry.
      throw Object.assign(
        new Error(r && r.error ? r.error : `[compiler] ${description} failed in stage '${entry.stage}' worker`),
        { code: 'compiler-stage-error', stage: entry.stage },
      )
    }
    return r
  }

  // (Re)warms one stage: respawns after a death (ensureAlive awaits the dead worker's
  // terminate() settlement first), then memoizes the warmup round trip per generation —
  // a live warm slot just awaits an already-resolved promise here.
  async function ensureWarm(entry) {
    const { slot } = entry
    await slot.ensureAlive()
    if (!entry.warmed || entry.warmedGen !== slot.generation) {
      entry.warmedGen = slot.generation
      // stages tells the worker its stage identity so toolchain-free stages (style)
      // can skip importing toolchainSetupURL at warmup.
      entry.warmed = requestChecked(
        entry,
        { type: 'warmup', toolchainSetupURL, stages: [entry.stage], wantHeartbeat: true },
        'warmup',
        warmupTimeoutMs,
      ).then(() => {}).catch((err) => {
        if (entry.warmedGen === slot.generation) entry.warmed = null
        throw err
      })
      entry.warmed.catch(() => {}) // observed even when an attempt aborts early on a sibling's failure
    }
    return entry.warmed
  }

  function warmup() {
    return settleAll(workers.map(ensureWarm))
  }

  // One full compile attempt against the resident realms. Ends quiescent: settleAll
  // guarantees no request is still in flight when it returns/throws, so a retry can
  // start fresh without cross-attempt FIFO pairing.
  async function runAttempt(files, workPath, options) {
    await settleAll(workers.map(ensureWarm))

    // Setup step — one worker runs setup ONCE: it parses config, builds
    // miniprogram_npm + app-config.json (the npm build can invoke the wasm toolchain)
    // and produces the scaffold. The resulting { pages, storeInfo } bundle is
    // broadcast to every stage so this heavy work runs once instead of per stage.
    // Scope ids are a deterministic hash(path) (dimina utils.js), so each stage would
    // derive identical `data-v-<id>` even from its own setup — the broadcast is a
    // de-dup optimization, NOT a scope-correctness requirement (scripts/test-pool-scopehash.js
    // asserts per-stage independent setup stays scope-consistent). Mirrors the Node
    // disk pool, which likewise sets up once and fans the same { pages, storeInfo } out.
    // `options` (e.g. { fileTypes }) only needs to reach THIS setup call: dmcc's
    // storeInfo() bakes the normalized dialect into the returned storeInfo object
    // (dimina/fe/packages/compiler/src/env.js:106-120), which rides inside `bundle`
    // below and is restored per-stage via resetStoreInfo (compile-core.js's
    // compileStage -> env.js:122-132) — so compile-subset never needs its own copy.
    const s = await requestChecked(workers[0], { type: 'setup', files, workPath, options, wantHeartbeat: true }, 'setup', sendTimeoutMs)
    const { bundle, scaffold } = s

    // Compile step — every stage compiles in parallel against the SHARED bundle. The
    // non-stage scaffold (app-config.json + npm, produced once) seeds the union.
    const parts = await settleAll(workers.map((x) =>
      requestChecked(x, { type: 'compile-subset', files, workPath, stages: [x.stage], bundle, wantHeartbeat: true }, 'compile-subset', sendTimeoutMs)))
    const merged = { ...(scaffold || {}) }
    for (const pr of parts) {
      Object.assign(merged, pr.result.files) // stages write disjoint files -> clean union
    }
    return { appId: bundle.appId, name: bundle.name, files: merged }
  }

  // Compiles share the resident realms, so they must not overlap — serialize them.
  let chain = Promise.resolve()

  /**
   * Single argument, no ambiguity: pass { files, workPath, options }. A bare
   * { relPath: content } map is also accepted (uses the default workPath, no options).
   * @param {{
   *   files: Record<string,string>,
   *   workPath?: string,
   *   options?: { fileTypes?: { template?: string[], style?: string[], viewScript?: string[] } },
   * } | Record<string,string>} input
   *   options.fileTypes lets a caller register a custom template/style/view-script
   *   dialect (e.g. { template: ['qdml'], style: ['qdss'], viewScript: ['qds'] }) —
   *   forwarded to the setup worker's `setupCompile` (dmcc's storeInfo).
   * @returns {Promise<{ appId: string, name: string, files: Record<string,string> }>}
   */
  function compile(input = {}) {
    const run = chain.then(async () => {
      if (disposed) {
        throw Object.assign(new Error('[compiler] pool has been disposed'), { code: 'compiler-pool-disposed' })
      }
      const files = input.files || input
      if (!files || typeof files !== 'object' || !Object.keys(files).length) {
        throw new Error('[compiler] pool.compile expects { files: { relPath: content }, workPath?, options? } (or a non-empty files map)')
      }
      const workPath = input.workPath || defaultWorkPath
      const options = input.options || {}
      try {
        return await runAttempt(files, workPath, options)
      } catch (err) {
        // A worker death is often transient (memory pressure, tab freeze, a one-off
        // toolchain stall) — retry the WHOLE attempt once on fresh workers. Real
        // compile errors (bad user source) are deterministic and are never retried.
        if (!retryOnWorkerDeath || !err || !WORKER_DEATH_CODES.has(err.code)) throw err
        return await runAttempt(files, workPath, options)
      }
    })
    // keep the chain alive regardless of this compile's outcome
    chain = run.then(() => {}, () => {})
    return run
  }

  async function dispose() {
    disposed = true
    await Promise.all(workers.map((x) => x.slot.dispose()))
  }

  return { warmup, compile, dispose, stages: [...stages] }
}
