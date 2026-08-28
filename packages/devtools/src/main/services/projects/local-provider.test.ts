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

  // ── updateProject: the project-edit dialog's persistence path ──────────
  //
  //  - the rename must survive a reload (a provider that only mutated its
  //    in-memory copy would pass a same-instance assertion and lose the edit
  //    on the next app start).
  //  - an empty iconUrl must REMOVE the field, not store '': the card treats
  //    any non-empty string as an image URL, so a stored '' would render a
  //    broken <img> where the name-initial fallback belongs.
  //  - path is the record's identity — an edit must never move it, or every
  //    other per-project store (compile config, thumbnail) is orphaned.
  it('updateProject renames the matching record and the rename survives a reload', async () => {
    const dir = '/projects/rename-me'
    fsState.dirs.add(dir)
    fsState.files.set(`${dir}/app.json`, '{}')

    const provider = createLocalProjectsProvider()
    await provider.addProject(dir)

    if (!provider.updateProject) {
      throw new Error('LocalProjectsProvider must implement updateProject')
    }
    const updated = await provider.updateProject(dir, { name: '  改名后的项目  ' })
    expect(updated.name).toBe('改名后的项目')
    expect(updated.path).toBe(dir)

    const reread = (await createLocalProjectsProvider().listProjects())[0]!
    expect(reread.name).toBe('改名后的项目')
    expect(reread.path).toBe(dir)
  })

  it('updateProject stores iconUrl, and an empty iconUrl removes the field', async () => {
    const dir = '/projects/iconic'
    fsState.dirs.add(dir)
    fsState.files.set(`${dir}/app.json`, '{}')

    const provider = createLocalProjectsProvider()
    await provider.addProject(dir)
    if (!provider.updateProject) {
      throw new Error('LocalProjectsProvider must implement updateProject')
    }

    await provider.updateProject(dir, { iconUrl: 'https://cdn.example.com/icon.png' })
    expect((await provider.listProjects())[0]!.iconUrl).toBe(
      'https://cdn.example.com/icon.png',
    )

    await provider.updateProject(dir, { iconUrl: '   ' })
    const cleared = (await createLocalProjectsProvider().listProjects())[0]!
    expect('iconUrl' in cleared).toBe(false)
  })

  it('updateProject leaves untouched fields (and other records) alone', async () => {
    const dirA = '/projects/a'
    const dirB = '/projects/b'
    for (const d of [dirA, dirB]) {
      fsState.dirs.add(d)
      fsState.files.set(`${d}/app.json`, '{}')
    }

    const provider = createLocalProjectsProvider()
    await provider.addProject(dirA)
    await provider.addProject(dirB)
    await provider.updateLastOpened!(dirA)
    const beforeA = (await provider.listProjects()).find((p) => p.path === dirA)!

    await provider.updateProject!(dirA, { name: 'A renamed' })

    const after = await provider.listProjects()
    const afterA = after.find((p) => p.path === dirA)!
    const afterB = after.find((p) => p.path === dirB)!
    expect(afterA.name).toBe('A renamed')
    expect(afterA.lastOpened).toBe(beforeA.lastOpened)
    expect(afterA.type).toBe(beforeA.type)
    expect(afterB.name).toBe('b')
  })

  it('updateProject rejects an empty name instead of storing it', async () => {
    const dir = '/projects/keep-name'
    fsState.dirs.add(dir)
    fsState.files.set(`${dir}/app.json`, '{}')

    const provider = createLocalProjectsProvider()
    const created = await provider.addProject(dir)

    // `.then(...)` so the assertion holds for both a sync throw (the local
    // provider) and a rejected promise (the async return the interface allows).
    await expect(
      Promise.resolve().then(() => provider.updateProject!(dir, { name: '   ' })),
    ).rejects.toThrow()
    expect((await provider.listProjects())[0]!.name).toBe(created.name)
  })

  it('updateProject throws for a path that is not in the list', async () => {
    const provider = createLocalProjectsProvider()
    await expect(
      Promise.resolve().then(() =>
        provider.updateProject!('/projects/never-imported', { name: 'x' }),
      ),
    ).rejects.toThrow()
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

  // ── Who owns the display name ──────────────────────────────────────────
  // The project's own config owns it; our list file only mirrors it. Same
  // arrangement as WeChat DevTools 36.6.0, which stores `projectname` in
  // project.private.config.json (URL-encoded past ASCII) and holds a copy in
  // its project list. Two owners is what makes a rename silently revert.

  it('addProject prefers projectname from project.private.config.json over project.config.json', async () => {
    const dir = '/projects/private-name'
    fsState.dirs.add(dir)
    fsState.files.set(`${dir}/app.json`, '{}')
    fsState.files.set(
      `${dir}/project.config.json`,
      JSON.stringify({ projectname: 'shared-name' }),
    )
    fsState.files.set(
      `${dir}/project.private.config.json`,
      JSON.stringify({ projectname: 'my-local-name' }),
    )

    const provider = createLocalProjectsProvider()
    expect((await provider.addProject(dir)).name).toBe('my-local-name')
  })

  it('addProject decodes a URL-encoded projectname', async () => {
    const dir = '/projects/encoded'
    fsState.dirs.add(dir)
    fsState.files.set(`${dir}/app.json`, '{}')
    fsState.files.set(
      `${dir}/project.config.json`,
      JSON.stringify({ projectname: '%E6%BD%AE%E7%8E%A9%E6%97%8F' }),
    )

    const provider = createLocalProjectsProvider()
    expect((await provider.addProject(dir)).name).toBe('潮玩族')
  })

  it('renaming writes projectname into project.private.config.json without dropping its other keys', async () => {
    const dir = '/projects/rename'
    const privatePath = `${dir}/project.private.config.json`
    fsState.dirs.add(dir)
    fsState.files.set(`${dir}/app.json`, '{}')
    fsState.files.set(
      privatePath,
      JSON.stringify({ libVersion: '3.16.2', setting: { urlCheck: true } }),
    )

    const provider = createLocalProjectsProvider()
    await provider.addProject(dir)
    await provider.updateProject!(dir, { name: '我的新名字' })

    const written = JSON.parse(fsState.files.get(privatePath)!)
    expect(written.projectname).toBe(encodeURIComponent('我的新名字'))
    expect(written.libVersion).toBe('3.16.2')
    expect(written.setting).toEqual({ urlCheck: true })
  })

  it('a renamed project keeps its new name when the same directory is imported again', async () => {
    // The regression: with the name owned only by our list file, re-importing
    // a directory refreshed it from project.config.json and threw the user's
    // rename away.
    const dir = '/projects/reimport'
    fsState.dirs.add(dir)
    fsState.files.set(`${dir}/app.json`, '{}')
    fsState.files.set(
      `${dir}/project.config.json`,
      JSON.stringify({ projectname: 'original' }),
    )

    const provider = createLocalProjectsProvider()
    await provider.addProject(dir)
    await provider.updateProject!(dir, { name: '改名后' })

    expect((await provider.addProject(dir)).name).toBe('改名后')
    const list = await createLocalProjectsProvider().listProjects()
    expect(list.filter((p) => p.path === dir).map((p) => p.name)).toEqual(['改名后'])
  })

  it('editing only the icon leaves the project directory untouched', async () => {
    const dir = '/projects/icon-only'
    fsState.dirs.add(dir)
    fsState.files.set(`${dir}/app.json`, '{}')

    const provider = createLocalProjectsProvider()
    await provider.addProject(dir)
    const before = [...fsState.files.keys()].filter((p) => p.startsWith(`${dir}/`)).sort()

    const updated = await provider.updateProject!(dir, {
      iconUrl: 'https://cdn.example.com/a.png',
    })
    expect(updated.iconUrl).toBe('https://cdn.example.com/a.png')

    const after = [...fsState.files.keys()].filter((p) => p.startsWith(`${dir}/`)).sort()
    expect(after).toEqual(before)
  })

  it('renaming refuses to overwrite a malformed project.private.config.json', async () => {
    // That file also carries the user's IDE settings and compile conditions;
    // rewriting it from `{}` because it failed to parse would drop them.
    const dir = '/projects/broken-private'
    const privatePath = `${dir}/project.private.config.json`
    fsState.dirs.add(dir)
    fsState.files.set(`${dir}/app.json`, '{}')
    fsState.files.set(privatePath, '{ "setting": { broken')

    const provider = createLocalProjectsProvider()
    await provider.addProject(dir)
    await expect(
      Promise.resolve().then(() => provider.updateProject!(dir, { name: 'nope' })),
    ).rejects.toThrow()

    expect(fsState.files.get(privatePath)).toBe('{ "setting": { broken')
    const list = await provider.listProjects()
    expect(list.find((p) => p.path === dir)!.name).not.toBe('nope')
  })
})
