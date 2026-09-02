// An image that a page references must survive the whole compile: seeded as bytes,
// copied by the compiler into the product, and handed back byte-identical. It used to
// come back corrupted — collectOutputs read every product with 'utf8', which replaces
// each invalid byte with U+FFFD and cannot be undone, so downstreams were told in the
// README to go read the fs themselves for real assets.
//
// Drives the real compile seams against the `base` example, which references
// pages/project-mixed/pages/detail/ui.png from its wxml.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { seedMemfs } from '../src/seed-memfs.js'

const APP = process.env.APP_DIR
  || fileURLToPath(new URL('../../../dimina/fe/example/base', import.meta.url))

const TEXT_EXT = new Set([
  '.json', '.js', '.ts', '.wxml', '.ddml', '.wxss', '.ddss', '.less',
  '.scss', '.sass', '.wxs', '.dds', '.css',
])

let failed = 0
const chk = (cond, msg) => { if (cond) { console.log(`✅ ${msg}`) } else { console.log(`❌ ${msg}`); failed++ } }
const sameBytes = (a, b) => a && b && a.length === b.length && [...a].every((x, i) => x === b[i])

// Unlike the older seams tests, this one seeds binary files too — that filter was the
// workaround for the gap under test here.
const files = {}
const readDir = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) { readDir(full); continue }
    const rel = path.relative(APP, full).split(path.sep).join('/')
    files[rel] = TEXT_EXT.has(path.extname(name).toLowerCase())
      ? readFileSync(full, 'utf8')
      : new Uint8Array(readFileSync(full))
  }
}
readDir(APP)

const binarySources = Object.entries(files).filter(([, v]) => v instanceof Uint8Array)
chk(binarySources.length > 0, `the fixture really carries binary sources (${binarySources.map(([k]) => k).join(', ')})`)

const { setupCompile, compileStage, collectOutputs, STAGE_NAMES } = await import('../dist/compile-core.node.js')

const workPath = '/work'
const fs = seedMemfs(files, workPath)
const ctx = await setupCompile({ fs, workPath })
for (const stage of STAGE_NAMES) {
  await compileStage({ stage, pages: ctx.pages, storeInfo: ctx.storeInfo, fs })
}
const out = collectOutputs({ fs, targetPath: ctx.targetPath })

const products = Object.entries(out)
const byteProducts = products.filter(([, v]) => v instanceof Uint8Array)
chk(byteProducts.length > 0,
  `the compiler's copied assets come back as bytes, not decoded text (${byteProducts.length} of ${products.length} products: ${byteProducts.map(([k]) => k).join(', ')})`)

for (const [srcPath, srcBytes] of binarySources) {
  const match = byteProducts.find(([, v]) => sameBytes(v, srcBytes))
  const copied = products.some(([k]) => k.endsWith(path.basename(srcPath)))
  // Only assets a page actually references are copied into the product; one that is
  // never referenced legitimately has no product to compare against.
  if (match) chk(true, `${srcPath} reached the product byte-identical (as ${match[0]})`)
  else chk(!copied, `${srcPath} is not referenced by any page, so it has no product (nothing named like it was emitted)`)
}

const appConfig = out[Object.keys(out).find((k) => k.endsWith('app-config.json'))]
chk(typeof appConfig === 'string' && JSON.parse(appConfig), 'UTF-8 products are still plain strings (app-config.json parses)')
const jsProducts = products.filter(([k, v]) => k.endsWith('.js') && typeof v === 'string')
chk(jsProducts.length > 0, `compiled JS products are still strings (${jsProducts.length} of them)`)
const cssProducts = products.filter(([k, v]) => k.endsWith('.css') && typeof v === 'string')
chk(cssProducts.length > 0, `compiled CSS products are still strings (${cssProducts.length} of them)`)
const mojibake = products.filter(([, v]) => typeof v === 'string' && v.includes('�'))
chk(mojibake.length === 0, `no product came back with replacement characters (${mojibake.map(([k]) => k).join(', ') || 'none'})`)

console.log(failed ? `\n❌ ${failed} binary-output assertion(s) failed.` : '\n✅ referenced assets survive the compile byte-identical; text products are unchanged.')
process.exit(failed ? 1 : 0)
