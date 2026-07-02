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
 * }} options
 */
export function createCompilerPool(options = {}) {
  const {
    createWorker,
    toolchainSetupURL,
    stages = DEFAULT_STAGES,
    workPath: defaultWorkPath = '/work',
  } = options
  if (typeof createWorker !== 'function') {
    throw new Error('[web-compiler] createCompilerPool: options.createWorker (() => Worker) is required')
  }
  if (!toolchainSetupURL) {
    throw new Error('[web-compiler] createCompilerPool: options.toolchainSetupURL is required')
  }

  // one resident worker per stage. send() returns a promise resolved by the worker's
  // next message; replies are FIFO so a per-worker queue pairs them up.
  const workers = stages.map((stage) => {
    const w = createWorker()
    const q = []
    w.onmessage = (e) => { const r = q.shift(); if (r) r(e.data) }
    w.onerror = (e) => { const r = q.shift(); if (r) r({ type: 'error', error: (e && e.message) || 'stage worker error' }) }
    return { stage, w, send: (m) => new Promise((res) => { q.push(res); w.postMessage(m) }) }
  })

  let warmed = null
  async function warmup() {
    if (!warmed) {
      warmed = Promise.all(workers.map((x) => x.send({ type: 'warmup', toolchainSetupURL })))
        .then((rs) => { for (const r of rs) if (r && r.type === 'error') throw new Error(r.error) })
        .catch((err) => { warmed = null; throw err })
    }
    return warmed
  }

  // Compiles share the resident realms, so they must not overlap — serialize them.
  let chain = Promise.resolve()

  /**
   * @param {{ files: Record<string,string> } | Record<string,string>} source
   * @param {{ workPath?: string }} [opts]
   * @returns {Promise<{ appId: string, name: string, files: Record<string,string> }>}
   */
  function compile(source, opts = {}) {
    const run = chain.then(async () => {
      await warmup()
      const files = source && source.files ? source.files : source
      if (!files || typeof files !== 'object') throw new Error('[web-compiler] pool.compile: source must be a { relPath: content } map (or { files })')
      const workPath = opts.workPath || defaultWorkPath
      const parts = await Promise.all(workers.map((x) =>
        x.send({ type: 'compile-subset', files, workPath, stages: [x.stage] })))
      const merged = {}
      let appId, name
      for (const pr of parts) {
        if (!pr || pr.type === 'error') throw new Error((pr && pr.error) || 'stage worker error')
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
