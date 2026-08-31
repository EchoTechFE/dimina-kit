// Toolchain wiring of dist/stage-worker.browser.js: the worker `import()`s the host's
// wasm toolchainSetupURL (esbuild-wasm + oxc) once per worker and remembers the URL
// across messages. Every stage needs it — including style, whose CSS pipeline is
// bundled in but whose minify step runs through esbuild's `transform` on non-sourcemap
// builds. A style worker that skipped the import compiled no CSS at all; it failed with
// "[esbuild] globalThis.__esbuildTransform not installed by host".
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

// Same counter, plus stand-in toolchain hooks so a stage that actually calls them
// (style's minify step) can complete. `__esbuildTransform` echoes its input, which is
// enough for the CSS product assertions below.
const cssToolchainURL = (markerName) => 'data:text/javascript,' + encodeURIComponent(
  `globalThis.${markerName}=(globalThis.${markerName}||0)+1;`
  + 'globalThis.__esbuildTransform=async(code)=>({code});'
  + 'globalThis.__oxcParseSync=()=>{throw new Error("stand-in oxc hook")};',
)

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

// --- A + B: the style stage loads the host toolchain and really minifies CSS ----
// The stand-in hook returns its input unchanged, so a compile that reaches the
// minify step still yields CSS carrying the fixture's declaration.
{
  const marker = '__stageToolchainMark_styleWarmup'
  const worker = await loadWorkerInstance()
  const warmupReply = await worker.send({
    type: 'warmup',
    toolchainSetupURL: cssToolchainURL(marker),
    stages: ['style'],
  })
  chk(warmupReply && warmupReply.type === 'ready',
    `style-only worker warmup succeeds — got ${JSON.stringify(warmupReply)}`)
  chk(globalThis[marker] === 1,
    `style-only warmup imports toolchainSetupURL exactly once (count=${globalThis[marker] || 0})`)
}
{
  // Fresh instance, no prior warmup at all — compile-subset must resolve the
  // toolchain from the URL it carries. Every simulated worker shares this process's
  // globalThis, so hooks installed by an earlier setup module have to be cleared
  // first; otherwise a worker that never imported its toolchain would still find
  // them and the assertion would pass on borrowed state.
  delete globalThis.__esbuildTransform
  delete globalThis.__oxcParseSync
  const marker = '__stageToolchainMark_styleCompile'
  const styleWorker = await loadWorkerInstance()
  const compileReply = await styleWorker.send({
    type: 'compile-subset',
    files: FIXTURE_FILES,
    workPath: WORK_PATH,
    stages: ['style'],
    toolchainSetupURL: cssToolchainURL(marker),
  })
  chk(compileReply && compileReply.type === 'done',
    `style-only compile-subset succeeds — got ${JSON.stringify(compileReply && compileReply.type === 'error' ? compileReply.error : compileReply)}`)
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

// --- G: the warmup URL carries over to a later compile-subset that carries none,
// and the toolchain is imported once per worker, not once per message --------------
{
  const marker = '__stageToolchainMark_remembered'
  const worker = await loadWorkerInstance()
  const warmupReply = await worker.send({
    type: 'warmup',
    toolchainSetupURL: cssToolchainURL(marker),
    stages: ['style'],
  })
  chk(warmupReply && warmupReply.type === 'ready', 'style-declared worker warmup succeeds with a working setup module')
  chk(globalThis[marker] === 1,
    `style-declared warmup imports the setup module once (count=${globalThis[marker] || 0})`)
  // The stand-in oxc hook throws, so this logic compile cannot succeed. What must
  // hold is that it resolves the toolchain from the warmup URL instead of failing
  // "no toolchainSetupURL", and that it does not import the module a second time.
  const compileReply = await worker.send({
    type: 'compile-subset',
    files: FIXTURE_FILES,
    workPath: WORK_PATH,
    stages: ['logic'],
    // no toolchainSetupURL — the worker must fall back to the URL remembered at warmup
  })
  chk(globalThis[marker] === 1,
    `logic compile-subset reuses the already-loaded toolchain instead of re-importing it (count=${globalThis[marker]})`)
  chk(!!compileReply && !(compileReply.type === 'error' && /no toolchainSetupURL|not warmed up/.test(String(compileReply.error))),
    `logic compile-subset after warmup does not fail as un-warmed — got ${JSON.stringify(compileReply && (compileReply.type === 'error' ? String(compileReply.error).slice(0, 100) : compileReply.type))}`)
}

// --- H: a worker is BOUND to the first toolchainSetupURL it ever loads. ESM caches
// modules per URL, so a second `import()` of the same URL cannot re-run a different
// module's install side effects — "switch to a new toolchain mid-lifetime" is not
// something a worker can actually do. A message carrying a different URL must be
// rejected (the caller's fix is to route that toolchain to a fresh worker instead),
// and the rejection must not have imported the new module at all.
{
  const markerA = '__stageToolchainMark_boundA'
  const markerB = '__stageToolchainMark_boundB'
  const worker = await loadWorkerInstance()

  const warmupReply = await worker.send({
    type: 'warmup',
    toolchainSetupURL: cssToolchainURL(markerA),
    stages: ['style'],
  })
  chk(warmupReply && warmupReply.type === 'ready', 'bound-URL worker warmup with toolchain A succeeds')
  chk(globalThis[markerA] === 1, `toolchain A imported once at warmup (count=${globalThis[markerA] || 0})`)

  const urlA = cssToolchainURL(markerA)
  const urlB = cssToolchainURL(markerB)
  const compileReplyB = await worker.send({
    type: 'compile-subset',
    files: FIXTURE_FILES,
    workPath: WORK_PATH,
    stages: ['style'],
    toolchainSetupURL: urlB,
  })
  chk(compileReplyB && compileReplyB.type === 'error',
    `compile-subset carrying a different toolchainSetupURL (B) is rejected instead of switching — got ${JSON.stringify(compileReplyB && compileReplyB.type)}`)
  const rejectionMsg = compileReplyB && compileReplyB.type === 'error' ? String(compileReplyB.error) : ''
  chk(rejectionMsg.includes(urlA) && rejectionMsg.includes(urlB),
    `the rejection names both the bound URL (A) and the offending one (B) — got ${JSON.stringify(rejectionMsg.slice(0, 200))}`)
  chk(!(markerB in globalThis),
    `toolchain B was never imported by the rejected message (count=${globalThis[markerB] || 0})`)
  chk(globalThis[markerA] === 1, `toolchain A's import count is unaffected by the rejected switch attempt (count=${globalThis[markerA]})`)

  const compileReplyA2 = await worker.send({
    type: 'compile-subset',
    files: FIXTURE_FILES,
    workPath: WORK_PATH,
    stages: ['style'],
    toolchainSetupURL: urlA,
  })
  chk(compileReplyA2 && compileReplyA2.type === 'done',
    `a later compile-subset that repeats the bound URL (A) still succeeds — got ${JSON.stringify(compileReplyA2 && compileReplyA2.type === 'error' ? compileReplyA2.error : compileReplyA2.type)}`)
  chk(globalThis[markerA] === 1, `toolchain A stays imported once total, not once per message (count=${globalThis[markerA]})`)
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

rawLog(failed ? `\n❌ ${failed} stage-toolchain assertion(s) failed.` : '\n✅ every stage loads the wasm toolchain, the load is memoized per setup URL, and the pool announces worker stage identity.')
realProcessExit(failed ? 1 : 0)
