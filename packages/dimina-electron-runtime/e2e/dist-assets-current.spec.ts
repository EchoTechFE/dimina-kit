/**
 * The whole e2e suite boots this package's `dist/`, and the parts of it that decide mini-app semantics are not built here at all: `build-assets.mjs` copies them verbatim out of `packages/devtools/dist` (the devtools build is what injects the simulator's service-API overlays into the dimina service bundle — the overlays that make sync `FileSystemManager` methods throw and that route audio/upload/WebSocket through the container).
 *
 * A copy left behind by an older devtools build therefore does not fail loudly: the runtime boots fine and the mini-app silently gets upstream behaviour instead of the simulator's, so unrelated-looking specs go red while the source tree is innocent.
 * This spec restates `build-assets.mjs`'s postcondition — every copied asset is byte-identical to the devtools build it came from — so a stale copy is reported as itself.
 *
 * Not a substitute for building devtools: it compares the copy against `packages/devtools/dist`, so it can only catch drift between the two.
 */
import { test, expect } from '@playwright/test'
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = path.resolve(__dirname, '..')
const DEVTOOLS_DIR = path.resolve(PACKAGE_DIR, '..', 'devtools')

/** Mirrors the asset list in `build-assets.mjs`. */
const COPIED_DIRS = ['dist/simulator', 'dist/service-host', 'dist/render-host', 'dist/native-host']
const COPIED_FILES: Array<{ from: string, to: string }> = [
  { from: 'dist/preload/windows/simulator.cjs', to: 'dist/preload/simulator.cjs' },
]

const REBUILD_HINT = 'run `pnpm --filter @dimina-kit/electron-runtime build:assets`'

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    out.push(path.relative(dir, path.join(entry.parentPath, entry.name)))
  }
  return out.sort()
}

function hashFile(file: string): string {
  return createHash('sha1').update(fs.readFileSync(file)).digest('hex')
}

test.describe('dist assets copied from the devtools build', () => {
  test('every copied asset matches its devtools source', () => {
    expect(
      fs.existsSync(path.join(DEVTOOLS_DIR, 'dist')),
      'packages/devtools/dist is missing — the comparison source has not been built',
    ).toBe(true)

    const drift: string[] = []
    for (const rel of COPIED_DIRS) {
      const mine = path.join(PACKAGE_DIR, rel)
      const theirs = path.join(DEVTOOLS_DIR, rel)
      const mineFiles = new Set(listFiles(mine))
      const theirsFiles = listFiles(theirs)
      for (const file of theirsFiles) {
        if (!mineFiles.has(file)) {
          drift.push(`${rel}/${file}: missing from this package's dist`)
          continue
        }
        mineFiles.delete(file)
        if (hashFile(path.join(mine, file)) !== hashFile(path.join(theirs, file))) {
          drift.push(`${rel}/${file}: differs from the devtools build`)
        }
      }
      for (const file of mineFiles) drift.push(`${rel}/${file}: left over, not in the devtools build`)
    }
    for (const { from, to } of COPIED_FILES) {
      const mine = path.join(PACKAGE_DIR, to)
      const theirs = path.join(DEVTOOLS_DIR, from)
      if (!fs.existsSync(mine)) drift.push(`${to}: missing from this package's dist`)
      else if (hashFile(mine) !== hashFile(theirs)) drift.push(`${to}: differs from ${from}`)
    }

    expect(drift, `dist assets are out of date — ${REBUILD_HINT}:\n${drift.join('\n')}`).toEqual([])
  })

  /**
   * Matching the devtools build is not enough on its own: `build-native-host.mjs` copies whatever `dimina/fe/packages/service/dist` happens to hold, and that dist only carries the simulator's service-API overlays when it was produced by the injecting container build.
   * A bundle built straight from upstream sources copies over just as cleanly and hands the mini-app upstream behaviour — sync FSM methods answering `undefined` instead of throwing, audio/upload/WebSocket bypassing the container backends.
   */
  test('the shipped service bundle carries the simulator service-API overlays', () => {
    const overlaySource = path.join(DEVTOOLS_DIR, 'src/simulator/service-apis/file/index.js')
    const reason = /SYNC_UNSUPPORTED_REASON\s*=\s*'([^']+)'/.exec(fs.readFileSync(overlaySource, 'utf8'))?.[1]
    expect(reason, `could not read the overlay marker out of ${overlaySource}`).toBeTruthy()

    const bundle = path.join(PACKAGE_DIR, 'dist/native-host/service/service.js')
    expect(
      fs.readFileSync(bundle, 'utf8').includes(reason!),
      `${bundle} was built without the overlays — ${REBUILD_HINT}`,
    ).toBe(true)
  })
})
