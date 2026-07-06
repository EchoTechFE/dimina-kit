// Retry-after-failure contract for preloadStage() (dist/compile-core.node.js):
// preloadStage(stage) dynamically imports that stage's chunk under
// dist/compile-core.node-chunks/. If a stage's chunk is transiently missing
// (e.g. a half-written dist, a filesystem hiccup) and the first preloadStage()
// call rejects, that failure must not be cached forever — once the chunk is
// available again, a later preloadStage() call for the same stage must
// resolve normally instead of replaying the same rejection.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

let failed = false
const chk = (cond, msg) => { if (!cond) { failed = true; console.error(`❌ ${msg}`) } else console.log(`✅ ${msg}`) }
const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT: ${label} did not settle in ${ms}ms`)), ms).unref()),
])

const chunksDir = fileURLToPath(new URL('../dist/compile-core.node-chunks', import.meta.url))
const backupDir = `${chunksDir}.bak`

chk(fs.existsSync(chunksDir), `precondition: ${chunksDir} exists before the test breaks it`)

// Entry module import happens while the chunks directory is intact — only the
// per-stage dynamic import inside preloadStage() touches the chunks lazily.
const { preloadStage } = await import('../dist/compile-core.node.js')

let brokenApplied = false
try {
  fs.renameSync(chunksDir, backupDir)
  brokenApplied = true

  const firstOutcome = await withTimeout(
    preloadStage('style').then(() => ({ resolved: true }), (e) => ({ resolved: false, error: e })),
    15000,
    'preloadStage(style) while chunks dir is missing',
  )
  chk(firstOutcome.resolved === false,
    `preloadStage('style') rejects while dist/compile-core.node-chunks is missing (got ${JSON.stringify(firstOutcome)})`)
} finally {
  if (brokenApplied) {
    fs.renameSync(backupDir, chunksDir)
    brokenApplied = false
  }
}

chk(fs.existsSync(chunksDir), 'dist/compile-core.node-chunks is restored before the retry attempt')

const secondOutcome = await withTimeout(
  preloadStage('style').then(() => ({ resolved: true }), (e) => ({ resolved: false, error: e })),
  15000,
  'preloadStage(style) after chunks dir is restored',
)
chk(secondOutcome.resolved === true,
  `preloadStage('style') resolves once dist/compile-core.node-chunks is restored — the earlier rejection must not be cached (got ${JSON.stringify(secondOutcome.resolved ? secondOutcome : { resolved: false, error: String(secondOutcome.error) })})`)

console.log(failed ? '\n❌ FAIL' : '\n✅ PASS: preloadStage() does not permanently cache a transient chunk-load failure')
process.exit(failed ? 1 : 0)
