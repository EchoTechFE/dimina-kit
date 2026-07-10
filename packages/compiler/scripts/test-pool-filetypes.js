// Red/green coverage for `options.fileTypes` (custom template/style/view-script
// dialect, e.g. .qdml/.qdss/.qds) reaching the browser pool's compile protocol.
//
// dmcc's env.js already normalizes options.fileTypes into a `compilerOptions`
// bundle inside storeInfo (dimina/fe/packages/compiler/src/env.js:91-120), and
// that bundle rides inside bundle.storeInfo through the setup->compile-subset
// broadcast (compile-core.js's compileStage -> resetStoreInfo, env.js:122-132) —
// see src/pool.js's runAttempt and src/stage-worker.js's runSetup/compileSubset.
// This test drives the REAL browser bundles (dist/pool.browser.js +
// dist/stage-worker.browser.js) in Node, so it fails (red) without the
// options-threading fix and passes (green) with it — no reimplementation of the
// protocol handlers under test.
//
// Fixture mirrors qdmp's e2e "qd-app" (see
// ~/code/qdmp/main/packages/qdmp-devtools/e2e/qd-app): a page using .qdml/.qdss/.qds
// instead of .wxml/.wxss/.wxs, with a <wxs src="./index.qds" module="m" /> view
// script and a `{{ m.shout(title) }}` mustache expression — so a correct compile
// must recognize the custom template AND the custom view-script extension.
//
// Also covers compile-core.js's compileMiniApp (the one-shot worker entry point)
// at the bottom, since it shares the exact same options-threading gap.

// Warm real esbuild/oxc-parser module eval AND esbuild's long-lived service child
// process with the REAL process object BEFORE masking (below) — the service, once
// spawned, is reused for later transforms even under a masked process, so this
// must run first.
import { transform } from 'esbuild'
import 'oxc-parser'

await transform('const __warm = 1', {})

// dart-sass's bundled browser shim checks process.versions.node at module-eval
// time (only reached once the lazily-loaded style-compiler chunk imports it) —
// masking to a browser-shaped stub makes it take the browser branch instead of
// crashing on `Dynamic require of "url" is not supported` (see
// scripts/test-stage-toolchain.js for the same technique). Saved so PART B below
// (a Node-target bundle, which needs the real process — its transitive deps
// module-eval-check process.versions.node too) can restore it.
const realProcess = globalThis.process
globalThis.process = { env: {}, cwd: () => '/' }

const WORKER_URL = new URL('../dist/stage-worker.browser.js', import.meta.url).href
const TOOLCHAIN_URL = new URL('./toolchain-setup-node-native.js', import.meta.url).href
const WORK_PATH = '/work'

const FIXTURE_FILES = {
  'app.json': JSON.stringify({ pages: ['pages/index/index'], window: { navigationBarTitleText: 'QD Ext Demo' } }),
  'project.config.json': JSON.stringify({ appid: 'qd_ext_demo_001', projectname: 'qd-ext-demo' }),
  'app.js': "App({\n  onLaunch() {\n    console.log('[QDExt] App launched')\n  },\n})\n",
  'pages/index/index.js': "Page({\n  data: {\n    title: 'QD Extensions',\n    count: 3,\n  },\n})\n",
  'pages/index/index.qdss': '.qd-box {\n  padding: 20rpx;\n}\n\n.qd-title {\n  font-size: 36rpx;\n  color: #4A90D9;\n}\n\n.qd-item {\n  font-size: 28rpx;\n  color: #333;\n}\n',
  'pages/index/index.qdml': '<wxs src="./index.qds" module="m" />\n<view class="qd-box">\n  <view class="qd-title" id="qd-title">{{ m.shout(title) }}</view>\n  <view class="qd-item" wx:for="{{count}}" wx:key="*this">item-{{item}}</view>\n</view>\n',
  'pages/index/index.json': JSON.stringify({ navigationBarTitleText: 'QD Ext Index' }),
  'pages/index/index.qds': "function shout(text) {\n  return text + '!'\n}\n\nmodule.exports = {\n  shout: shout,\n}\n",
}
const FILE_TYPES_OPTIONS = { fileTypes: { template: ['qdml'], style: ['qdss'], viewScript: ['qds'] } }

let failed = false
const chk = (cond, msg) => { if (!cond) { failed = true; console.error(`❌ ${msg}`) } else console.log(`✅ ${msg}`) }

// Real page module: exists, non-empty, and carries the compiled .qds wxs module
// (`shout`) plus the compiled .qdml view (`qd-title`) — the assertion this whole
// test hinges on. Without options.fileTypes this is guaranteed to fail (the
// custom extensions are unrecognized, so the page template/view-script are never
// found), which is exactly the RED this test protects against regressing to.
function pageModuleIsCompiled(files) {
  const js = files && files['main/pages_index_index.js']
  return typeof js === 'string' && js.length > 0 && js.includes('shout') && js.includes('qd-title')
}

// --- PART A: real browser pool (dist/pool.browser.js + dist/stage-worker.browser.js) ---
//
// Each stage worker is its own dynamically-imported module instance (own closure
// state, mirroring a real Web Worker realm); ALL of them funnel through one shared
// `chain` so only one is ever "in flight" at a time. This matters because the
// worker module resolves the bare `self` identifier against whatever
// `globalThis.self` currently is (see test-stage-toolchain.js's note on the same
// mechanism) — serializing every send means no two realms' async continuations
// can ever race over that shared global.
let chain = Promise.resolve()
let instanceCounter = 0
async function makeStageWorker() {
  const worker = { onmessage: null, onerror: null, terminate() {} }
  const fakeSelf = {
    onmessage: null,
    postMessage(msg) { if (worker.onmessage) worker.onmessage({ data: msg }) },
  }
  globalThis.self = fakeSelf
  instanceCounter += 1
  await import(`${WORKER_URL}?n=${instanceCounter}`)
  // stage-worker.js does `self.onmessage = async (e) => {...}` at module top level
  // against whatever `globalThis.self` was AT IMPORT TIME — capture it now.
  const boundOnMessage = fakeSelf.onmessage
  worker.postMessage = (msg) => {
    chain = chain.then(async () => {
      globalThis.self = fakeSelf
      try {
        await boundOnMessage({ data: msg })
      } catch (err) {
        // The real handler already catches internally and posts { type:'error' };
        // an escaping exception would mean it threw before its own try, so surface
        // it the same way rather than hanging the pool's pending request forever.
        fakeSelf.postMessage({ type: 'error', error: String((err && err.stack) || err) })
      }
    })
  }
  return worker
}

const { createCompilerPool } = await import('../dist/pool.browser.js')

// One pool, pre-spawned with exactly the 3 default-stage workers this test needs
// (no crash/respawn expected) — createWorker must be synchronous (pool.js calls it
// inline), so every worker instance is built up front and handed out from a queue.
const stageWorkers = []
for (const stage of ['logic', 'view', 'style']) stageWorkers.push(await makeStageWorker())
let nextWorker = 0
const pool = createCompilerPool({
  createWorker: () => stageWorkers[nextWorker++],
  toolchainSetupURL: TOOLCHAIN_URL,
})

const withoutOptions = await pool.compile({ files: FIXTURE_FILES, workPath: WORK_PATH })
chk(!pageModuleIsCompiled(withoutOptions.files),
  'PART A (pool.js + stage-worker.js): WITHOUT options.fileTypes, the .qdml/.qdss/.qds page module is NOT compiled '
  + `(demonstrates the gap this feature closes; got main/pages_index_index.js=${JSON.stringify(withoutOptions.files['main/pages_index_index.js'])})`)

const withOptions = await pool.compile({ files: FIXTURE_FILES, workPath: WORK_PATH, options: FILE_TYPES_OPTIONS })
chk(pageModuleIsCompiled(withOptions.files),
  'PART A (pool.js + stage-worker.js): WITH options.fileTypes, the .qdml/.qdss/.qds page module IS compiled and non-empty '
  + `(main/pages_index_index.js length=${(withOptions.files['main/pages_index_index.js'] || '').length})`)
chk(withOptions.appId === 'qd_ext_demo_001', `PART A: compiled appId matches project.config.json (got ${withOptions.appId})`)
const compiledCss = withOptions.files['main/pages_index_index.css'] || ''
chk(compiledCss.includes('qd-title'), `PART A: .qdss style file compiled into page CSS (got ${JSON.stringify(compiledCss)})`)

await pool.dispose()

// --- PART B: compile-core.js's compileMiniApp (one-shot worker entry point) ---
// Same options-threading gap, covered directly at the compile-core level (no
// pool/worker-protocol involved) so a future pool refactor still has this pinned
// independently of the browser-pool wiring above. This is the NODE-target bundle
// (dist/compile-core.node.js), whose deps expect a real `process` — restore it
// before importing.
globalThis.process = realProcess
const { compileMiniApp } = await import('../dist/compile-core.node.js')
const { Volume, createFsFromVolume } = await import('memfs')
const freshFs = () => createFsFromVolume(Volume.fromJSON(FIXTURE_FILES, WORK_PATH))

const coreWithout = await compileMiniApp({ fs: freshFs(), workPath: WORK_PATH })
chk(!pageModuleIsCompiled(coreWithout.files),
  'PART B (compile-core.js compileMiniApp): WITHOUT options.fileTypes, page module NOT compiled')

const coreWith = await compileMiniApp({ fs: freshFs(), workPath: WORK_PATH, options: FILE_TYPES_OPTIONS })
chk(pageModuleIsCompiled(coreWith.files),
  'PART B (compile-core.js compileMiniApp): WITH options.fileTypes, page module IS compiled and non-empty '
  + `(length=${(coreWith.files['main/pages_index_index.js'] || '').length})`)

console.log(failed ? '\n❌ FAIL' : '\n✅ PASS: options.fileTypes reaches the browser pool protocol (pool.js/stage-worker.js) and compile-core.js\'s compileMiniApp')
process.exit(failed ? 1 : 0)
