/**
 * Contract tests for LocalProjectsProvider.
 *
 * LocalProjectsProvider is the default ProjectsProvider used when no host
 * injection is supplied. It MUST implement the same persistence/validation
 * behavior the old free-function project-repository exposed — otherwise
 * downstream code (workspace-service, IPC handlers) regresses silently.
 *
 * Each test names a concrete bug it would catch:
 *  - listProjects/addProject/removeProject persist through the same
 *    dimina-projects.json file — if a refactor splits the storage path, the
 *    second call won't see the first's write and these break.
 *  - addProject reads projectname from project.config.json — a refactor that
 *    forgets this would silently regress every existing user's project name
 *    after the next add.
 *  - duplicate adds must update-in-place (not append a second entry) — a
 *    careless `.push()` would corrupt the list.
 *  - updateLastOpened mutates lastOpened on the matching record — a no-op
 *    refactor here breaks "recently opened" ordering in the UI.
 *  - getCompileConfig returns defaults for unknown paths, persisted config
 *    for known ones — wrong wiring drops user customisations.
 *  - validateProjectDir surfaces the miniprogramRoot hint when app.json is
 *    missing but project.config.json points elsewhere — a regression here
 *    sends users into a confusing error loop.
 *
 * The ProjectsProvider interface allows async returns; LocalProjectsProvider
 * is sync, but tests `await` results to remain valid even if a later
 * refactor moves to async I/O.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── In-memory filesystem stub ────────────────────────────────────────────
const fsState = vi.hoisted(() => {
  /** key: absolute path; value: file content (string) */
  const files = new Map<string, string>()
  /** absolute paths that should report as existing directories (no content) */
  const dirs = new Set<string>()

  function reset() {
    files.clear()
    dirs.clear()
  }

  return { files, dirs, reset }
})

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/userdata'),
  },
  default: {
    app: { getPath: () => '/userdata' },
  },
}))

vi.mock('fs', async () => {
  const real = await vi.importActual<typeof import('fs')>('fs')

  function existsSync(p: import('fs').PathLike): boolean {
    const s = String(p)
    return fsState.files.has(s) || fsState.dirs.has(s)
  }

  function readFileSync(
    p: import('fs').PathOrFileDescriptor,
    _opts?: unknown,
  ): string {
    const s = String(p)
    if (!fsState.files.has(s)) {
      throw Object.assign(new Error('ENOENT: ' + s), { code: 'ENOENT' })
    }
    return fsState.files.get(s)!
  }

  function writeFileSync(
    p: import('fs').PathOrFileDescriptor,
    data: string | Buffer | Uint8Array,
  ): void {
    const s = String(p)
    fsState.files.set(
      s,
      typeof data === 'string' ? data : Buffer.from(data).toString('utf8'),
    )
  }

  const mocked = {
    ...real,
    existsSync,
    readFileSync,
    writeFileSync,
    default: undefined as unknown,
  }
  ;(mocked as { default: unknown }).default = mocked
  return mocked
})

// ── Lazy imports (after mocks) ───────────────────────────────────────────
let createLocalProjectsProvider: typeof import('./local-provider.js').createLocalProjectsProvider

beforeEach(async () => {
  fsState.reset()
  vi.resetModules()
  ;({ createLocalProjectsProvider } = await import('./local-provider.js'))
})

const PROJECTS_FILE = '/userdata/dimina-projects.json'

describe('LocalProjectsProvider — ProjectsProvider contract', () => {
  it('returns [] when the projects file does not exist (no throw)', async () => {
    const provider = createLocalProjectsProvider()
    expect(await provider.listProjects()).toEqual([])
  })

  it('addProject then listProjects shows the new project (round-trip through dimina-projects.json)', async () => {
    const dir = '/projects/a'
    fsState.dirs.add(dir)
    fsState.files.set(`${dir}/app.json`, '{"pages":["pages/x"]}')

    const provider = createLocalProjectsProvider()
    const created = await provider.addProject(dir)
    expect(created.path).toBe(dir)

    // Persisted to disk under the expected path.
    expect(fsState.files.has(PROJECTS_FILE)).toBe(true)

    // A *fresh* provider instance must see the same data — proves the read
    // path actually consults the persisted file, not in-memory state.
    const fresh = createLocalProjectsProvider()
    const list = await fresh.listProjects()
    expect(list).toHaveLength(1)
    expect(list[0]!.path).toBe(dir)
  })

  it('addProject reads `projectname` from project.config.json and uses it as the display name', async () => {
    const dir = '/projects/with-config'
    fsState.dirs.add(dir)
    fsState.files.set(`${dir}/app.json`, '{}')
    fsState.files.set(
      `${dir}/project.config.json`,
      JSON.stringify({ projectname: '我的小程序' }),
    )

    const provider = createLocalProjectsProvider()
    const created = await provider.addProject(dir)
    expect(created.name).toBe('我的小程序')
  })

  it('addProject on a path already in the list does NOT create a duplicate entry', async () => {
    const dir = '/projects/dup'
    fsState.dirs.add(dir)
    fsState.files.set(`${dir}/app.json`, '{}')

    const provider = createLocalProjectsProvider()
    await provider.addProject(dir)
    await provider.addProject(dir)

    const list = await provider.listProjects()
    expect(list.filter((p) => p.path === dir)).toHaveLength(1)
  })

  it('removeProject deletes the matching entry and persists', async () => {
    const dirA = '/projects/a'
    const dirB = '/projects/b'
    for (const d of [dirA, dirB]) {
      fsState.dirs.add(d)
      fsState.files.set(`${d}/app.json`, '{}')
    }

    const provider = createLocalProjectsProvider()
    await provider.addProject(dirA)
    await provider.addProject(dirB)
    await provider.removeProject(dirA)

    const after = await provider.listProjects()
    expect(after.map((p) => p.path)).toEqual([dirB])

    // Verify it's also gone in a fresh instance (persisted).
    const fresh = createLocalProjectsProvider()
    const reread = await fresh.listProjects()
    expect(reread.map((p) => p.path)).toEqual([dirB])
  })

  it('updateLastOpened sets a non-null ISO timestamp on the matching entry', async () => {
    const dir = '/projects/a'
    fsState.dirs.add(dir)
    fsState.files.set(`${dir}/app.json`, '{}')

    const provider = createLocalProjectsProvider()
    await provider.addProject(dir)
    const before = (await provider.listProjects())[0]!
    expect(before.lastOpened ?? null).toBeNull()

    if (!provider.updateLastOpened) {
      throw new Error('LocalProjectsProvider must implement updateLastOpened')
    }
    await provider.updateLastOpened(dir)
    const after = (await provider.listProjects())[0]!
    expect(typeof after.lastOpened).toBe('string')
    expect(() => new Date(after.lastOpened!).toISOString()).not.toThrow()
  })

  it('getCompileConfig returns defaults for unknown paths and persisted config for known ones', async () => {
    const dir = '/projects/a'
    fsState.dirs.add(dir)
    fsState.files.set(`${dir}/app.json`, '{}')

    const provider = createLocalProjectsProvider()
    if (!provider.getCompileConfig || !provider.saveCompileConfig) {
      throw new Error('LocalProjectsProvider must implement getCompileConfig/saveCompileConfig')
    }
    const defaults = await provider.getCompileConfig(dir)
    expect(defaults.startPage).toBe('')
    expect(Array.isArray(defaults.queryParams)).toBe(true)

    await provider.addProject(dir)
    await provider.saveCompileConfig(dir, {
      startPage: 'pages/home',
      scene: 1001,
      queryParams: [{ key: 'k', value: 'v' }],
    })
    const after = await provider.getCompileConfig(dir)
    expect(after.startPage).toBe('pages/home')
    expect(after.scene).toBe(1001)
  })

  it('validateProjectDir returns null for a directory containing app.json', async () => {
    const dir = '/projects/ok'
    fsState.dirs.add(dir)
    fsState.files.set(`${dir}/app.json`, '{}')

    const provider = createLocalProjectsProvider()
    expect(await provider.validateProjectDir?.(dir)).toBeNull()
  })

  it('validateProjectDir surfaces miniprogramRoot hint when app.json missing but project.config.json points elsewhere', async () => {
    const dir = '/projects/wrapper'
    fsState.dirs.add(dir)
    // NO app.json at root.
    fsState.files.set(
      `${dir}/project.config.json`,
      JSON.stringify({ miniprogramRoot: 'src' }),
    )

    const provider = createLocalProjectsProvider()
    const msg = await provider.validateProjectDir?.(dir)
    expect(typeof msg).toBe('string')
    expect(msg!).toContain('src')
  })

  it('validateProjectDir rejects empty path and non-existent path with distinct messages', async () => {
    const provider = createLocalProjectsProvider()
    const emptyMsg = await provider.validateProjectDir?.('')
    expect(typeof emptyMsg).toBe('string')
    expect(emptyMsg!.length).toBeGreaterThan(0)

    const missing = await provider.validateProjectDir?.('/projects/does-not-exist')
    expect(typeof missing).toBe('string')
    expect(missing!).toContain('/projects/does-not-exist')
  })
})
