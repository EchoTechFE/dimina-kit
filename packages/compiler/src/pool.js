// Orchestrated compile pool — the "batteries-included" export. The downstream calls
// createCompilerPool(...).compile(source) and gets the merged build back; the pool
// owns ALL the orchestration the downstream used to hand-write:
//   - a resident worker per stage, kept warm so the wasm toolchain loads ONCE
//   - dmcc-consistent stage-level parallelism (logic | view | style each in a realm)
//   - realm reuse across compiles (resetCompilerState inside the worker)
//   - dispatch + disjoint-output merge
//
// What stays with the downstream is only what is genuinely host-specific:
//   - createWorker(): how to spawn a module Worker running this package's stage worker
//     (bundler/hosting-specific — one line)
//   - toolchainSetupURL: an ESM the worker imports to install the two wasm hooks
//     (esbuild.wasm / oxc wasm are host-hosted assets)
//   - the source itself (a { relPath: content } map). OPFS is intentionally NOT here:
//     it's an optional zero-copy source-distribution the downstream can layer on.

const DEFAULT_STAGES = ['logic', 'view', 'style']

// Default ceiling for a single setup/compile-subset round trip. A stuck or crashed stage
// worker would otherwise leave its send() promise pending forever — and since compile()
// awaits those promises, the whole compile() call (and the downstream fallback keyed off
// its rejection) would silently hang too. warmup() is intentionally NOT covered by this
// timeout: a cold wasm-toolchain fetch can legitimately take longer than a compile step.
const DEFAULT_SEND_TIMEOUT_MS = 30000

/**
 * @param {{
 *   createWorker: () => Worker,     // required: spawn a module worker running dist/stage-worker.browser.js
 *   toolchainSetupURL: string,      // required: ESM URL that installs __esbuildTransform/__oxcParseSync in the worker
 *   stages?: string[],              // default ['logic','view','style']
 *   workPath?: string,              // default '/work'
 *   onLog?: (entry: { level: string, message: string }) => void,  // worker console diagnostics
 *   sendTimeoutMs?: number,         // default 30000 — per setup/compile-subset round trip
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
  } = options
  if (typeof createWorker !== 'function') {
    throw new Error('[compiler] createCompilerPool: options.createWorker (() => Worker) is required')
  }
  if (!toolchainSetupURL) {
    throw new Error('[compiler] createCompilerPool: options.toolchainSetupURL is required')
  }

  // One resident worker per stage, tracked as a mutable entry so a dead worker (timeout /
  // crash) can be torn down and respawned in place — compile() always closes over the
  // SAME `workers` array of entries, never a fresh one.
  const workers = stages.map((stage) => {
    const entry = { stage, w: null, q: [], dead: false, warmed: null }
    spawn(entry)
    return entry
  })

  // (Re)creates the underlying Worker for a pool entry and wires its message/error
  // handlers. Used both for the initial construction above and for lazy respawn (see
  // ensureWarm) after a timeout or crash marks the entry dead.
  function spawn(entry) {
    const stage = entry.stage
    const w = createWorker()
    entry.w = w
    entry.dead = false
    w.onmessage = (e) => {
      const d = e.data
      // Diagnostics the compiler logs inside the worker (missing components, unsupported
      // wx APIs, style-preprocessor fallbacks, …) arrive as out-of-band { type:'log' }
      // messages — surface them via onLog instead of pairing them with a send() reply.
      if (d && d.type === 'log') { if (onLog) { try { onLog({ level: d.level, message: d.message, stage }) } catch { /* ignore */ } } return }
      const r = entry.q.shift(); if (r) r(d)
    }
    // Fails every reply still queued for this worker with the same `{ type: 'error' }`
    // sentinel shape callers already check for (see the pre-existing onerror handling
    // this replaces) and marks the entry dead so the NEXT compile() lazily respawns it
    // instead of reusing a worker that can no longer be trusted.
    const fail = (message, code) => {
      entry.dead = true
      entry.warmed = null
      while (entry.q.length) {
        const r = entry.q.shift()
        if (r) r({ type: 'error', error: message, code })
      }
    }
    w.onerror = (ev) => {
      // Worker-script-level failure (module load / uncaught). ErrorEvent.message is often
      // empty for these — surface filename:lineno and a hint so it's not a bare "error".
      const msg = (ev && (ev.message || (ev.error && ev.error.message)))
        || 'worker failed to load or threw (no message — often a module-load / static-asset / cross-origin failure)'
      const where = ev && ev.filename ? ` (${ev.filename}:${ev.lineno || 0})` : ''
      fail(`[compiler] stage '${stage}' worker error: ${msg}${where}`, 'compiler-worker-crashed')
    }
    w.onmessageerror = () => {
      fail(`[compiler] stage '${stage}' worker sent an unstructured-clonable message (onmessageerror)`, 'compiler-worker-crashed')
    }
  }

  // send() pairs replies FIFO per worker. Every message EXCEPT 'warmup' is guarded by
  // sendTimeoutMs: if the worker never replies (wedged / silently dead — postMessage to a
  // hung worker neither throws nor answers) the promise still settles, with a
  // `{ type:'error', code:'compiler-worker-timeout' }` sentinel, and the entry is marked
  // dead for lazy respawn. warmup is exempt because a cold wasm fetch can legitimately
  // exceed a compile-step timeout.
  function send(entry, m) {
    return new Promise((resolve) => {
      if (m.type === 'warmup') {
        entry.q.push(resolve)
        entry.w.postMessage(m)
        return
      }
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const idx = entry.q.indexOf(resolver)
        if (idx !== -1) entry.q.splice(idx, 1)
        entry.dead = true
        entry.warmed = null
        resolve({
          type: 'error',
          error: `[compiler] stage '${entry.stage}' worker timed out after ${sendTimeoutMs}ms waiting for a reply to '${m.type}'`,
          code: 'compiler-worker-timeout',
        })
      }, sendTimeoutMs)
      // Deliberately NOT unref()'d (Node only — browsers have no such concept): this
      // timer is the only thing that guarantees a wedged worker's send() ever settles.
      // In a Node host with nothing else pending, unref() would let the process exit
      // before the timer fires at all, silently defeating the whole timeout.
      const resolver = (d) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(d)
      }
      entry.q.push(resolver)
      entry.w.postMessage(m)
    })
  }

  // Lazily respawns a dead entry (previous timeout/crash) and (re)warms it. Cheap on a
  // healthy pool: entry.warmed is memoized and only cleared on failure, so a live/warm
  // entry just awaits an already-resolved promise here.
  function ensureWarm(entry) {
    if (entry.dead) {
      try { entry.w.terminate() } catch { /* ignore — best effort */ }
      spawn(entry)
    }
    if (!entry.warmed) {
      // stages tells the worker its stage identity so toolchain-free stages (style)
      // can skip importing toolchainSetupURL at warmup.
      entry.warmed = send(entry, { type: 'warmup', toolchainSetupURL, stages: [entry.stage] })
        .then((r) => {
          // The worker's own try/catch reports the REAL cause (e.g. a toolchainSetupURL
          // import failure) as r.error — surface it verbatim, tagged with the stage.
          if (r && r.type === 'error') throw new Error(r.error || `[compiler] stage '${entry.stage}' warmup failed`)
        })
        .catch((err) => { entry.warmed = null; throw err })
    }
    return entry.warmed
  }

  function warmup() {
    return Promise.all(workers.map(ensureWarm))
  }

  // Compiles share the resident realms, so they must not overlap — serialize them.
  let chain = Promise.resolve()

  /**
   * Single argument, no ambiguity: pass { files, workPath }. A bare { relPath: content }
   * map is also accepted (uses the default workPath).
   * @param {{ files: Record<string,string>, workPath?: string } | Record<string,string>} input
   * @returns {Promise<{ appId: string, name: string, files: Record<string,string> }>}
   */
  function compile(input = {}) {
    const run = chain.then(async () => {
      await warmup()
      const files = input.files || input
      if (!files || typeof files !== 'object' || !Object.keys(files).length) {
        throw new Error('[compiler] pool.compile expects { files: { relPath: content }, workPath? } (or a non-empty files map)')
      }
      const workPath = input.workPath || defaultWorkPath

      // Phase 1 — one worker runs setup ONCE: it allocates the scope-hash ids
      // (page + component data-v-XXXXX) and builds miniprogram_npm/app-config.json.
      // Broadcasting this single bundle to every stage is REQUIRED for correctness:
      // each stage runs in its own realm, and if each ran its own setup it would roll
      // independent random uuids, so the CSS `[data-v-X]` selectors would never match
      // the render `Module id` and every WXSS rule would target nothing (regression
      // guarded by scripts/test-pool-scopehash.js). This mirrors the Node disk pool,
      // which likewise sets up once and fans the same { pages, storeInfo } out.
      const s = await send(workers[0], { type: 'setup', files, workPath })
      if (!s || s.type === 'error') {
        throw new Error(s && s.error ? s.error : `[compiler] setup phase failed in stage '${workers[0].stage}' worker`)
      }
      const { bundle, scaffold } = s

      // Phase 2 — every stage compiles in parallel against the SHARED bundle. The
      // non-stage scaffold (app-config.json + npm, produced once) seeds the union.
      const parts = await Promise.all(workers.map((x) =>
        send(x, { type: 'compile-subset', files, workPath, stages: [x.stage], bundle })))
      const merged = { ...(scaffold || {}) }
      for (let i = 0; i < parts.length; i++) {
        const pr = parts[i]
        // pr.error carries the worker's real error string (message + stack) — surface it.
        if (!pr || pr.type === 'error') throw new Error(pr && pr.error ? pr.error : `[compiler] stage '${workers[i].stage}' worker error`)
        Object.assign(merged, pr.result.files)   // stages write disjoint files -> clean union
      }
      return { appId: bundle.appId, name: bundle.name, files: merged }
    })
    // keep the chain alive regardless of this compile's outcome
    chain = run.then(() => {}, () => {})
    return run
  }

  function dispose() {
    for (const x of workers) { try { x.w.terminate() } catch { /* ignore */ } }
  }

  return { warmup, compile, dispose, stages: [...stages] }
}
