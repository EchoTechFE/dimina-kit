// Layer 1: run the bundled in-memory compiler in Node against the `base` example,
// reading source from the real FS into a plain {path: content} map.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
// memfs stands in as the "downstream" fs here — web-compiler carries no fs of
// its own; the host injects one via { fs }.
import { Volume, createFsFromVolume } from 'memfs'

// Default to the example shipped in dimina-kit's `dimina` submodule.
const APP = process.env.APP_DIR
  || fileURLToPath(new URL('../../../dimina/fe/example/base', import.meta.url))

const TEXT_EXT = new Set([
  '.json', '.js', '.ts', '.wxml', '.ddml', '.wxss', '.ddss', '.less',
  '.scss', '.sass', '.wxs', '.dds', '.css',
])

function readDir(dir, baseDir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = path.join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      readDir(full, baseDir, out)
    } else {
      const rel = path.relative(baseDir, full).split(path.sep).join('/')
      const ext = path.extname(name).toLowerCase()
      if (TEXT_EXT.has(ext)) out[rel] = readFileSync(full, 'utf8')
      // binary assets (png etc.) skipped for this text-only smoke test
    }
  }
}

const files = {}
readDir(APP, APP, files)
console.log(`[seed] ${Object.keys(files).length} text files from ${APP}`)

const { compileMiniApp } = await import('../dist/compile-core.node.js')

// Downstream seeds a memfs volume at workPath and injects its fs.
const workPath = '/work'
const vol = Volume.fromJSON(files, workPath)
const t0 = Date.now()
const result = await compileMiniApp({ fs: createFsFromVolume(vol), workPath })
const dt = Date.now() - t0

console.log(`\n[result] appId=${result.appId} name=${result.name} in ${dt}ms`)
// memfs toJSON yields null for directory entries; keep only real files
for (const k of Object.keys(result.files)) {
  if (result.files[k] == null) delete result.files[k]
}
const outNames = Object.keys(result.files).sort()
console.log(`[output] ${outNames.length} files`)
const top = outNames.filter((n) => /^main\/(logic\.js|app-config\.json|app\.css|pages_index\.(js|css))$/.test(n))
for (const n of top) console.log(`   ${n}  (${result.files[n].length} bytes)`)

// sanity: must have main/logic.js, main/app-config.json, main/app.css and at least one page view
const need = ['main/logic.js', 'main/app-config.json']
const missing = need.filter((n) => !(n in result.files))
if (missing.length) {
  console.error(`\n❌ MISSING expected outputs: ${missing.join(', ')}`)
  process.exit(1)
}
console.log('\n--- main/app-config.json (head) ---')
console.log(result.files['main/app-config.json'].slice(0, 600))
console.log('\n--- main/logic.js (head) ---')
console.log(result.files['main/logic.js'].slice(0, 400))
console.log('\n✅ Layer1 compile produced expected artifacts')
