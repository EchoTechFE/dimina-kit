// Turn a `{ relPath: content }` source map into a private memfs for one compile.
//
// Split out of the stage worker because of one memfs behavior that fails silently:
// `Volume.fromJSON` only understands string (and Buffer) values — hand it a plain
// Uint8Array and the path becomes a DIRECTORY, with no error anywhere. postMessage
// delivers every binary source file as exactly that (structured clone turns a Buffer
// into a Uint8Array), so an image in `files` used to end up as an empty directory and
// the compiled app referenced an asset that was never there.
import { Volume, createFsFromVolume } from 'memfs'

function joinUnder(workPath, relPath) {
  if (relPath.startsWith('/')) return relPath
  const base = workPath.endsWith('/') ? workPath.slice(0, -1) : workPath
  return `${base}/${relPath}`
}

/**
 * @param {Record<string, string | Uint8Array | null>} files source map; string values are
 *   seeded through memfs' own fromJSON, byte values are written in afterwards.
 * @param {string} workPath project root inside the volume, e.g. '/work'
 * @returns {object} a node:fs-shaped object over the fresh volume
 */
export function seedMemfs(files, workPath) {
  const text = {}
  const binary = []
  for (const [relPath, content] of Object.entries(files || {})) {
    if (content instanceof Uint8Array) binary.push([relPath, content])
    else text[relPath] = content
  }
  const fs = createFsFromVolume(Volume.fromJSON(text, workPath))
  for (const [relPath, bytes] of binary) {
    const full = joinUnder(workPath, relPath)
    const slash = full.lastIndexOf('/')
    if (slash > 0) fs.mkdirSync(full.slice(0, slash), { recursive: true })
    fs.writeFileSync(full, bytes)
  }
  return fs
}
