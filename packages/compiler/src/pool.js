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

/**
 * @param {{
 *   createWorker: () => Worker,     // required: spawn a module worker running dist/stage-worker.browser.js
 *   toolchainSetupURL: string,      // required: ESM URL that installs __esbuildTransform/__oxcParseSync in the worker
 *   stages?: string[],              // default ['logic','view','style']
 *   workPath?: string,              // default '/work'
 *   onLog?: (entry: { level: string, message: string }) => void,  // worker console diagnostics
 * }} options
 */
export function createCompilerPool(options = {}) {
  const {
    createWorker,
    toolchainSetupURL,
    stages = DEFAULT_STAGES,
    workPath: defaultWorkPath = '/work',
    onLog,
  } = options
  if (typeof createWorker !== 'function') {
    throw new Error('[compiler] createCompilerPool: options.createWorker (() => Worker) is required')
  }
  if (!toolchainSetupURL) {
    throw new Error('[compiler] createCompilerPool: options.toolchainSetupURL is required')
  }

  // one resident worker per stage. send() returns a promise resolved by the worker's
  // next message; replies are FIFO so a per-worker queue pairs them up.
  const workers = stages.map((stage) => {
    const w = createWorker()
    const q = []
    w.onmessage = (e) => {
      const d = e.data
      // Diagnostics the compiler logs inside the worker (missing components, unsupported
      // wx APIs, style-preprocessor fallbacks, …) arrive as out-of-band { type:'log' }
      // messages — surface them via onLog instead of pairing them with a send() reply.
      if (d && d.type === 'log') { if (onLog) { try { onLog({ level: d.level, message: d.message, stage }) } catch { /* ignore */ } } return }
      const r = q.shift(); if (r) r(d)
    }
    w.onerror = (ev) => {
      // Worker-script-level failure (module load / uncaught). ErrorEvent.message is often
      // empty for these — surface filename:lineno and a hint so it's not a bare "error".
      const msg = (ev && (ev.message || (ev.error && ev.error.message)))
        || 'worker failed to load or threw (no message — often a module-load / static-asset / cross-origin failure)'
      const where = ev && ev.filename ? ` (${ev.filename}:${ev.lineno || 0})` : ''
      const r = q.shift(); if (r) r({ type: 'error', error: `[compiler] stage '${stage}' worker error: ${msg}${where}` })
    }
    return { stage, w, send: (m) => new Promise((res) => { q.push(res); w.postMessage(m) }) }
  })

  let warmed = null
  async function warmup() {
    if (!warmed) {
      warmed = Promise.all(workers.map((x) => x.send({ type: 'warmup', toolchainSetupURL })))
        .then((rs) => rs.forEach((r, i) => {
          // The worker's own try/catch reports the REAL cause (e.g. a toolchainSetupURL
          // import failure) as r.error — surface it verbatim, tagged with the stage.
          if (r && r.type === 'error') throw new Error(r.error || `[compiler] stage '${workers[i].stage}' warmup failed`)
        }))
        .catch((err) => { warmed = null; throw err })
    }
    return warmed
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
      const parts = await Promise.all(workers.map((x) =>
        x.send({ type: 'compile-subset', files, workPath, stages: [x.stage] })))
      const merged = {}
      let appId, name
      for (let i = 0; i < parts.length; i++) {
        const pr = parts[i]
        // pr.error carries the worker's real error string (message + stack) — surface it.
        if (!pr || pr.type === 'error') throw new Error(pr && pr.error ? pr.error : `[compiler] stage '${workers[i].stage}' worker error`)
        appId = pr.result.appId
        name = pr.result.name
        Object.assign(merged, pr.result.files)   // stages write disjoint files -> clean union
      }
      return { appId, name, files: merged }
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
