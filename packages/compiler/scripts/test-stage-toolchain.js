// Per-stage toolchain skip: dist/stage-worker.browser.js currently `import()`s the
// host's wasm toolchainSetupURL (esbuild-wasm + oxc) on EVERY warmup and
// compile-subset call, regardless of which stage the worker actually runs. The
// style stage's compile path (postcss/cssnano/autoprefixer) is bundled in and never
// touches `__esbuildTransform`/`__oxcParseSync`, so a style-only worker paying that
// import cost is pure waste — and, observably, it means a style worker can't warm up
// at all if the host's toolchainSetupURL is broken/unreachable, even though style
// never needed it.
//
// This drives the raw worker message protocol directly (no bundler / real Worker):
// dist/stage-worker.browser.js is a self-contained ESM (browser platform, memfs +
// browser shims inlined), so it can be `import()`ed straight into Node once a fake
// `self` (postMessage/onmessage) is installed on globalThis and the REAL Node
// `process` global is masked during the import — dart-sass's bundled browser shim
// checks `process.versions.node` at module-eval time and takes a `require()` path
// that esbuild's browser platform build cannot satisfy (`Dynamic require of "url"
// is not supported`) when it sees the real Node process object.
//
// Each `import(url + '?n=' + n)` with a distinct query string forces Node to load a
// FRESH module instance (own `toolchainReady` cache, own `self.onmessage` closure),
// which is how independent worker instances are simulated here. The worker's console
// patch forwards console.* to `self.postMessage({ type: 'log' })` after the first
// import — this test never calls console.* through a live `self`, only through a
// `rawLog` reference captured before any import.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const realProcessExit = process.exit.bind(process)
const rawLog = console.log.bind(console)

// dart-sass's node-vs-browser branch (see stage-worker.browser.js bundle) reads
// `process.versions.node` once at module-eval time. Masking the global with a
// browser-shaped process (no `versions`) BEFORE any worker import makes the bundle
// take the same path it would in a real browser. `realProcessExit` above keeps a
// working exit for this script's own end regardless of this override.
globalThis.process = { env: {}, cwd: () => '/' }

const WORKER_URL = new URL('../dist/stage-worker.browser.js', import.meta.url).href
const POOL_MODULE = require.resolve('../dist/pool.browser.js')

let failed = 0
function chk(cond, msg) {
  if (cond) rawLog(`✅ ${msg}`)
  else { rawLog(`❌ ${msg}`); failed++ }
}

// A toolchainSetupURL that always fails to import — stands in for both "points at
// a URL that doesn't exist" and "points at a module whose import throws" (memfs/oxc
// setup modules do the latter in practice; the failure shape ensureToolchain()
// surfaces is identical either way).
const UNREACHABLE_TOOLCHAIN_URL = 'file:///no/such/path/toolchain-setup-nonexistent.mjs'

// A distinct `data:` URL per marker name is a distinct module specifier, so Node
// gives each a fresh module record — importing it increments a globalThis counter
// exactly once per actual `import()` call. Reusing the SAME marker name across two
// sends would hit Node's module cache on the second import and silently read as
// "imported once" even if the code path runs twice, so every assertion below uses
// its own marker name.
const sideEffectURL = (markerName) => `data:text/javascript,globalThis.${markerName}=(globalThis.${markerName}||0)%2B1`

// --- fake `self` (Worker global scope) + message round-trip -------------------
function makeFakeSelf() {
  const inbox = []
  let waiter = null
  const fakeSelf = {
    onmessage: null,
    postMessage(msg) {
      inbox.push(msg)
      if (waiter) { const w = waiter; waiter = null; w() }
    },
  }
  // Diagnostics arrive out-of-band as { type:'log' } (see stage-worker.js's console
  // forwarding) interleaved with the real reply — skip them, same as pool.js does.
  fakeSelf.waitForReply = () => new Promise((resolve) => {
    function tryDrain() {
      while (inbox.length) {
        const m = inbox.shift()
        if (m && m.type === 'log') continue
        resolve(m)
        return
      }
      waiter = tryDrain
    }
    tryDrain()
  })
  return fakeSelf
}

let instanceCounter = 0
async function loadWorkerInstance() {
  const fakeSelf = makeFakeSelf()
  globalThis.self = fakeSelf
  instanceCounter += 1
  await import(`${WORKER_URL}?n=${instanceCounter}`)
  return {
    // Sends are driven strictly sequentially (never two in-flight sends across
    // different instances) — the worker module resolves the bare `self` identifier
    // against whatever `globalThis.self` is AT CALL TIME, not at import time, so an
    // in-flight send from a different instance would misdirect this one's reply.
    async send(msg) {
      globalThis.self = fakeSelf
      const reply = fakeSelf.waitForReply()
      fakeSelf.onmessage({ data: msg })
      return reply
    },
  }
}

const FIXTURE_FILES = {
  'app.json': JSON.stringify({ pages: ['pages/index/index'] }),
  'app.js': 'App({})',
  'pages/index/index.js': 'Page({})',
  'pages/index/index.wxml': '<view>hi</view>',
  'pages/index/index.wxss': '.x{color:red}',
  'pages/index/index.json': '{}',
}
const WORK_PATH = '/work'

function findCompiledCss(files) {
  return Object.entries(files || {}).find(([k, v]) => k.endsWith('.css') && typeof v === 'string' && v.includes('color:red'))
}

// --- A + B: style-only worker never needs the wasm toolchain ------------------
{
  const styleWorker = await loadWorkerInstance()
  const warmupReply = await styleWorker.send({
    type: 'warmup',
    toolchainSetupURL: UNREACHABLE_TOOLCHAIN_URL,
    stages: ['style'],
  })
  chk(warmupReply && warmupReply.type === 'ready',
    `style-only worker warmup succeeds with an unreachable toolchainSetupURL (skips the wasm import) — got ${JSON.stringify(warmupReply)}`)
}
{
  // Fresh instance, no prior warmup at all — isolates compile-subset's OWN skip
  // decision from warmup's memoized toolchainReady state.
  const styleWorker = await loadWorkerInstance()
  const compileReply = await styleWorker.send({
    type: 'compile-subset',
    files: FIXTURE_FILES,
    workPath: WORK_PATH,
    stages: ['style'],
    toolchainSetupURL: UNREACHABLE_TOOLCHAIN_URL,
  })
  chk(compileReply && compileReply.type === 'done',
    `style-only compile-subset succeeds with an unreachable toolchainSetupURL — got ${JSON.stringify(compileReply && compileReply.type === 'error' ? compileReply.error : compileReply)}`)
  const css = compileReply && compileReply.type === 'done' ? findCompiledCss(compileReply.result.files) : null
  chk(!!css, `style-only compile-subset produced a real compiled CSS product (found "${css && css[0]}": ${css && JSON.stringify(css[1])})`)
}

// --- C: logic / view stage worker behavior is unchanged — still imports the
// toolchain exactly once per warmup ---------------------------------------------
for (const stage of ['logic', 'view']) {
  const marker = `__stageToolchainMark_${stage}`
  const worker = await loadWorkerInstance()
  const reply = await worker.send({
    type: 'warmup',
    toolchainSetupURL: sideEffectURL(marker),
    stages: [stage],
  })
  chk(reply && reply.type === 'ready', `${stage} worker warmup succeeds`)
  chk(globalThis[marker] === 1, `${stage} worker warmup imports toolchainSetupURL exactly once (count=${globalThis[marker]})`)
}

// --- D: an unrecognized custom stage name loads the toolchain conservatively ---
{
  const marker = '__stageToolchainMark_custom'
  const worker = await loadWorkerInstance()
  const reply = await worker.send({
    type: 'warmup',
    toolchainSetupURL: sideEffectURL(marker),
    stages: ['my-custom-stage'],
  })
  chk(reply && reply.type === 'ready', 'unknown custom stage worker warmup succeeds')
  chk(globalThis[marker] === 1, `unknown custom stage "my-custom-stage" still imports toolchainSetupURL (conservative default; count=${globalThis[marker]})`)
}

// --- E: warmup with no `stages` field at all (pre-optimization callers) stays
// conservative too ---------------------------------------------------------------
{
  const marker = '__stageToolchainMark_legacy'
  const worker = await loadWorkerInstance()
  const reply = await worker.send({
    type: 'warmup',
    toolchainSetupURL: sideEffectURL(marker),
    // no `stages` field — the pre-optimization warmup message shape
  })
  chk(reply && reply.type === 'ready', 'legacy warmup (no stages field) succeeds')
  chk(globalThis[marker] === 1, `legacy warmup without a stages field still imports toolchainSetupURL (count=${globalThis[marker]})`)
}

// --- G: a worker that skipped the import at warmup must still REMEMBER the
// warmup URL — a later compile-subset that needs the toolchain (logic stage) and
// carries no toolchainSetupURL of its own must import the remembered URL instead
// of failing "no toolchainSetupURL / not warmed up" ------------------------------
{
  const marker = '__stageToolchainMark_deferred'
  // Besides counting the import, install stand-in toolchain hooks so the logic
  // compile has SOMETHING to call if it gets that far. The compile outcome itself
  // is not the guarded contract (stand-in hooks may not satisfy the full logic
  // pipeline) — what must hold is that the remembered URL gets imported and the
  // failure mode is NOT the "no toolchainSetupURL" warmup error.
  const setupURL = 'data:text/javascript,' + encodeURIComponent(
    `globalThis.${marker}=(globalThis.${marker}||0)+1;`
    + 'globalThis.__esbuildTransform=async(code)=>({code});'
    + 'globalThis.__oxcParseSync=()=>{throw new Error("stand-in oxc hook")};',
  )
  const worker = await loadWorkerInstance()
  const warmupReply = await worker.send({
    type: 'warmup',
    toolchainSetupURL: setupURL,
    stages: ['style'],
  })
  chk(warmupReply && warmupReply.type === 'ready', 'style-declared worker warmup succeeds with a working setup module')
  chk((globalThis[marker] || 0) === 0,
    `style-declared warmup defers the setup-module import (count=${globalThis[marker] || 0})`)
  const compileReply = await worker.send({
    type: 'compile-subset',
    files: FIXTURE_FILES,
    workPath: WORK_PATH,
    stages: ['logic'],
    // no toolchainSetupURL — the worker must fall back to the URL remembered at warmup
  })
  chk(globalThis[marker] === 1,
    `logic compile-subset without its own toolchainSetupURL imports the URL remembered at warmup (count=${globalThis[marker]})`)
  chk(!!compileReply && !(compileReply.type === 'error' && /no toolchainSetupURL|not warmed up/.test(String(compileReply.error))),
    `logic compile-subset after a deferred warmup does not fail as un-warmed — got ${JSON.stringify(compileReply && (compileReply.type === 'error' ? String(compileReply.error).slice(0, 100) : compileReply.type))}`)
}

// --- F: createCompilerPool tells each resident worker its own stage identity ---
{
  const { createCompilerPool } = await import(POOL_MODULE)
  const createdWorkers = []
  function createWorker() {
    const messages = []
    const w = {
      onmessage: null,
      postMessage(m) {
        messages.push(m)
        // Reply asynchronously, like a real Worker would, so pool.warmup()'s
        // send()/Promise pairing is exercised the same way it is in production.
        queueMicrotask(() => { if (w.onmessage) w.onmessage({ data: { type: 'ready' } }) })
      },
      terminate() {},
    }
    createdWorkers.push(messages)
    return w
  }

  const stages = ['logic', 'view', 'style']
  const pool = createCompilerPool({ createWorker, toolchainSetupURL: 'data:text/javascript,export default {}', stages })
  await pool.warmup()

  for (let i = 0; i < stages.length; i++) {
    const firstMessage = createdWorkers[i] && createdWorkers[i][0]
    chk(firstMessage && firstMessage.type === 'warmup', `pool sent a warmup message to the "${stages[i]}" worker`)
    chk(!!firstMessage && Array.isArray(firstMessage.stages) && firstMessage.stages.length === 1 && firstMessage.stages[0] === stages[i],
      `pool's warmup message to the "${stages[i]}" worker carries its own stage identity (stages:${JSON.stringify(firstMessage && firstMessage.stages)})`)
  }
}

rawLog(failed ? `\n❌ ${failed} stage-toolchain assertion(s) failed.` : '\n✅ style stage skips the wasm toolchain; logic/view/custom/legacy stay conservative; pool announces worker stage identity.')
realProcessExit(failed ? 1 : 0)
