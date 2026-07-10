/**
 * `project-fs.ts`'s exported `SKIP_DIRS` must be a SUPERSET of devkit's
 * `WATCH_IGNORE_DIRS`, derived from it (not an independently-maintained copy) —
 * the drift-proof guard so the never-source core (node_modules, VCS) can never
 * be dropped from the editor's directory-tree listing, the `/__fs/readdir`
 * mirror bridge, the WAL ledger seed, or the file-watcher's ignore list. The
 * mirror ADDS its own build-output names (`dist`, `build`, tool caches) on top,
 * which the devkit recompile watcher must NOT ignore — hence a superset, not an
 * identical object.
 */
import { describe, it, expect, vi } from 'vitest'

// `project-fs.ts` imports `WorkbenchContext`, which pulls in electron types
// only (no runtime electron call at module scope), but other devtools main
// tests mock electron defensively before importing main-process modules —
// follow the same pattern so this test does not depend on real electron
// being resolvable in the vitest environment.
vi.mock('electron', () => {
  const app = {
    getPath: vi.fn(() => '/tmp/dimina-test-userdata'),
    isPackaged: true,
  }
  return { app, default: {} }
})

describe('SKIP_DIRS is single-sourced from devkit', () => {
  it('is DERIVED from WATCH_IGNORE_DIRS — a sentinel added to the core flows through', async () => {
    // The load-bearing assertion: prove derivation, not a coincidental superset.
    // A plain "SKIP_DIRS ⊇ WATCH_IGNORE_DIRS" check would still pass if someone
    // reverted project-fs to a parallel hardcoded list that happened to cover
    // today's four core members — the drift would silently return. Injecting a
    // sentinel into the devkit core and re-importing project-fs proves SKIP_DIRS
    // is actually built from it.
    vi.resetModules()
    vi.doMock('@dimina-kit/devkit/watch-ignore', () => ({
      WATCH_IGNORE_DIRS: new Set(['node_modules', '__derivation_sentinel__']),
    }))
    const { SKIP_DIRS } = await import('./project-fs.js')
    expect(SKIP_DIRS.has('__derivation_sentinel__')).toBe(true)
    // The mirror still layers its own build-output names on top of the core.
    expect(SKIP_DIRS.has('dist')).toBe(true)
    vi.doUnmock('@dimina-kit/devkit/watch-ignore')
    vi.resetModules()
  })

  it('shares the never-source core (node_modules present, dist is mirror-only)', async () => {
    const { SKIP_DIRS } = await import('./project-fs.js')
    const { WATCH_IGNORE_DIRS } = await import('@dimina-kit/devkit/watch-ignore')

    for (const dir of WATCH_IGNORE_DIRS) {
      expect(SKIP_DIRS.has(dir)).toBe(true)
    }
    // node_modules — the omission that once wedged watcher.close() for 2.6s —
    // lives in the shared core, so it can never drift off the devtools side.
    expect(WATCH_IGNORE_DIRS.has('node_modules')).toBe(true)
    // dist/build are the mirror's own additions, NOT in the recompile core.
    expect(SKIP_DIRS.has('dist')).toBe(true)
    expect(WATCH_IGNORE_DIRS.has('dist')).toBe(false)
  })
})
