/**
 * `/__fs/watch` path filtering: the SSE stream must drop exactly the paths the
 * `/__fs/readdir` bridge hides (SKIP_DIRS as a segment at any depth), so the
 * sync engine is never told about files the editor mirror cannot see.
 */
import { describe, expect, it, vi } from 'vitest'

// fs-watch-sse → project-fs → ipc-registry's top-level `import { ipcMain }
// from 'electron'`; CI has no Electron binary, so stub it (same as
// workbench-coi-server.test.ts).
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), off: vi.fn() } }))

import { __testing } from './fs-watch-sse.js'

const { shouldReportWatchPath } = __testing

describe('shouldReportWatchPath', () => {
  it('reports ordinary project paths', () => {
    expect(shouldReportWatchPath('app.js')).toBe(true)
    expect(shouldReportWatchPath('pages/index/index.wxml')).toBe(true)
  })

  it('drops SKIP_DIRS at the top level', () => {
    expect(shouldReportWatchPath('node_modules/pkg/index.js')).toBe(false)
    expect(shouldReportWatchPath('.git/HEAD')).toBe(false)
    expect(shouldReportWatchPath('dist/bundle.js')).toBe(false)
  })

  it('drops SKIP_DIRS nested below the top level (prefix matching missed these)', () => {
    expect(shouldReportWatchPath('packages/x/node_modules/pkg/index.js')).toBe(false)
    expect(shouldReportWatchPath('apps/demo/.git/config')).toBe(false)
  })

  it('does not treat a name that merely CONTAINS a skip dir as skipped', () => {
    expect(shouldReportWatchPath('my-dist/file.js')).toBe(true)
    expect(shouldReportWatchPath('node_modules_backup/file.js')).toBe(true)
  })

  it('drops the empty string and root-escaping paths', () => {
    expect(shouldReportWatchPath('')).toBe(false)
    expect(shouldReportWatchPath('../outside.js')).toBe(false)
    expect(shouldReportWatchPath('/abs/path.js')).toBe(false)
  })
})

describe('shouldReportWatchPath — documented edge', () => {
  it('pins the accepted narrowing: a plain FILE named exactly like a skip dir is unreported', () => {
    // readdir would still LIST such a file (only directories are filtered
    // there) — the watcher cannot cheaply know file-vs-dir for a deleted
    // path, so it drops the name outright. Documented in fs-watch-sse.ts.
    expect(shouldReportWatchPath('dist')).toBe(false)
    expect(shouldReportWatchPath('build')).toBe(false)
  })
})
