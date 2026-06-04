// Bundle the view-anchor core (src/view-anchor.ts) and inline it into the
// standalone 3D demo (docs/anchor-3d.html) between the marker comments.
//
// Why inline rather than `import './core.mjs'`: the demo is meant to open by
// double-click (file://), where browsers block ES-module imports as cross-origin
// (origin "null"). Inlining keeps the page self-contained while still using the
// real built artifact — the block below is GENERATED from src, never hand-edited.
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const htmlPath = resolve(root, 'docs/anchor-3d.html')

const START = '/* __VIEW_ANCHOR_CORE_START__ — generated from src/view-anchor.ts by `pnpm build:docs`; do not edit */'
const END = '/* __VIEW_ANCHOR_CORE_END__ */'

const result = await build({
  entryPoints: [resolve(root, 'src/view-anchor.ts')],
  bundle: true,
  format: 'iife',
  globalName: '__viewAnchorCore',
  target: 'es2020',
  write: false,
})
const code = result.outputFiles[0].text.trim()

const html = readFileSync(htmlPath, 'utf8')
const i = html.indexOf(START)
const j = html.indexOf(END)
if (i === -1 || j === -1 || j < i) {
  throw new Error('anchor-3d.html is missing the __VIEW_ANCHOR_CORE_{START,END}__ markers')
}
const next = html.slice(0, i) + START + '\n' + code + '\n' + END + html.slice(j + END.length)
writeFileSync(htmlPath, next)
console.log('inlined view-anchor core (%d bytes) into docs/anchor-3d.html', code.length)
