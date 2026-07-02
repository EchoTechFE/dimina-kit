// Emit an example's text source as a flat {relPath: content} JSON so the browser
// benchmark can seed each fs backend without a bundler.
//   usage: node gen-bench-fixture.js <dest.json> [example=base]
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const EXAMPLE = process.argv[3] || 'base'
const APP = fileURLToPath(new URL(`../../../dimina/fe/example/${EXAMPLE}`, import.meta.url))
const TEXT = new Set(['.json', '.js', '.ts', '.wxml', '.ddml', '.wxss', '.ddss', '.less', '.scss', '.sass', '.wxs', '.dds', '.css'])
const out = {}
;(function rd(d, b) {
  for (const n of readdirSync(d)) {
    if (n === 'node_modules' || n === '.git') continue
    const f = path.join(d, n)
    if (statSync(f).isDirectory()) rd(f, b)
    else if (TEXT.has(path.extname(n).toLowerCase())) out[path.relative(b, f).split(path.sep).join('/')] = readFileSync(f, 'utf8')
  }
})(APP, APP)

const dest = process.argv[2]
if (!dest) throw new Error('usage: node gen-bench-fixture.js <dest.json>')
writeFileSync(dest, JSON.stringify(out))
console.log(`fixture: ${Object.keys(out).length} files -> ${dest}`)
