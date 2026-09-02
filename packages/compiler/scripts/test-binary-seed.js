// A binary source file must reach the compiler as a FILE. postMessage hands the stage
// worker every image as a Uint8Array, and memfs' own `Volume.fromJSON` turns such a
// value into a DIRECTORY without erroring — the app then referenced an asset that was
// never in the volume. src/seed-memfs.js exists to close exactly that hole, so this
// test drives it directly (no build, no browser).
import { Volume } from 'memfs'
import { seedMemfs } from '../src/seed-memfs.js'

let failed = 0
const chk = (cond, msg) => { if (cond) { console.log(`✅ ${msg}`) } else { console.log(`❌ ${msg}`); failed++ } }
const sameBytes = (a, b) => a && b && a.length === b.length && [...a].every((x, i) => x === b[i])

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xc3, 0x28])

// The memfs behavior this module compensates for. If it ever changes, seed-memfs.js
// can be simplified — until then, dropping it silently loses every binary asset.
{
  const vol = Volume.fromJSON({ 'img/logo.png': PNG }, '/work')
  chk(vol.toJSON()['/work/img/logo.png'] === null,
    'Volume.fromJSON turns a Uint8Array value into a directory, no error raised — the reason seedMemfs exists')
}

{
  const fs = seedMemfs({ 'img/logo.png': PNG, 'app.json': '{"pages":[]}' }, '/work')
  chk(fs.statSync('/work/img/logo.png').isFile(), 'a Uint8Array source lands as a file, not a directory')
  chk(sameBytes(fs.readFileSync('/work/img/logo.png'), PNG),
    'its bytes are seeded verbatim, including the ones that are not valid UTF-8')
  chk(fs.readFileSync('/work/app.json', 'utf8') === '{"pages":[]}', 'text sources are unaffected')
}

{
  // A Uint8Array that is a WINDOW into a larger buffer (what slicing an upload gives
  // you) must write its own bytes only, not the whole backing buffer.
  const backing = new Uint8Array([0, 0, 0, 1, 2, 3, 0, 0])
  const view = backing.subarray(3, 6)
  const fs = seedMemfs({ 'a/b/c.bin': view }, '/work')
  chk(sameBytes(fs.readFileSync('/work/a/b/c.bin'), new Uint8Array([1, 2, 3])),
    `a byte view writes only its own range (got ${[...fs.readFileSync('/work/a/b/c.bin')]})`)
  chk(fs.statSync('/work/a/b').isDirectory(), 'missing parent directories are created for a binary source')
}

{
  const fs = seedMemfs({ '/elsewhere/logo.png': PNG, 'app.json': '{}' }, '/work')
  chk(sameBytes(fs.readFileSync('/elsewhere/logo.png'), PNG),
    'an absolute key is honored as-is, matching memfs fromJSON')
}

{
  const fs = seedMemfs({ 'img/logo.png': PNG }, '/work/')
  chk(fs.statSync('/work/img/logo.png').isFile(), 'a workPath with a trailing slash does not double the separator')
}

console.log(failed ? `\n❌ ${failed} binary-seed assertion(s) failed.` : '\n✅ binary sources reach the compiler as files with their exact bytes.')
process.exit(failed ? 1 : 0)
