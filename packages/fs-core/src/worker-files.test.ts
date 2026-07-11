/**
 * Guards the worker-artifact distribution contract helper: the file-name
 * list matches what build-workers.js actually emits, and path resolution
 * follows the "literal siblings of client.js" rule on both separators.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FS_CORE_WORKER_FILES, resolveWorkerFiles } from './worker-files.js'

describe('FS_CORE_WORKER_FILES', () => {
  it('matches the outfiles build-workers.js emits', () => {
    const buildScript = readFileSync(join(__dirname, '..', 'build-workers.js'), 'utf8')
    for (const name of FS_CORE_WORKER_FILES) {
      expect(buildScript).toContain(`dist/${name}`)
    }
  })
})

describe('resolveWorkerFiles', () => {
  it('resolves worker paths as siblings of client.js (POSIX)', () => {
    const r = resolveWorkerFiles('/repo/node_modules/@dimina-kit/fs-core/dist/client.js')
    expect(r.dir).toBe('/repo/node_modules/@dimina-kit/fs-core/dist')
    expect(r.files).toEqual([
      '/repo/node_modules/@dimina-kit/fs-core/dist/fs-core.worker.js',
      '/repo/node_modules/@dimina-kit/fs-core/dist/fs-query.worker.js',
    ])
  })

  it('preserves Windows separators', () => {
    const r = resolveWorkerFiles('C:\\proj\\node_modules\\@dimina-kit\\fs-core\\dist\\client.js')
    expect(r.dir).toBe('C:\\proj\\node_modules\\@dimina-kit\\fs-core\\dist')
    expect(r.files[0]).toBe('C:\\proj\\node_modules\\@dimina-kit\\fs-core\\dist\\fs-core.worker.js')
  })

  it('rejects a separator-less input', () => {
    expect(() => resolveWorkerFiles('client.js')).toThrow(/not a path/)
  })
})
