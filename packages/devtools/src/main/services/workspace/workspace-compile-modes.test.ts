/**
 * `WorkspaceService` opens a `CompileModeStore` for whichever project is
 * currently open and treats it as the sole authority for that project's
 * compile modes — `getCompileModeState`/`applyCompileModeCommand` only ever
 * read/act on the currently-open store, `closeProject` disposes it, and a
 * project whose open sequence fails after the store was already created
 * must not leave that store reachable.
 *
 * Pattern lifted from workspace-provider-injection.test.ts (mocked
 * electron/fs, createWorkbenchContext with an injected projectsProvider,
 * fresh module import per test via vi.resetModules()).
 *
 * Design: /Volumes/jdisk/code/dimina-kit-docs/compile-mode-store-design.md §2.4
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import { ProjectChannel } from '../../../shared/ipc-channels.js'
import type { CompileModes } from '../../../shared/types.js'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/userdata'),
    isPackaged: true,
  },
  webContents: { fromId: vi.fn(() => null) },
  default: {},
}))

// `createWorkbenchContext` statically imports default-adapter.ts, which
// resolves the package root by walking real directories with `fs.existsSync`
// at MODULE LOAD time — unconditionally, even when a test injects its own
// adapter and never touches the default one. So the mock can't blanket-deny
// every path the way the ENOENT-everywhere style elsewhere in this suite
// does; it must fall through to the real fs for anything outside the fake
// project/preload/renderer paths this file makes up, and only fake ENOENT
// for those.
const { fsMock } = vi.hoisted(() => ({
  fsMock: {} as {
    existsSync: ReturnType<typeof import('vitest').vi.fn>
    readFileSync: ReturnType<typeof import('vitest').vi.fn>
    writeFileSync: ReturnType<typeof import('vitest').vi.fn>
    defaultExistsSync: (...args: unknown[]) => unknown
    defaultReadFileSync: (...args: unknown[]) => unknown
  },
}))

vi.mock('fs', async () => {
  const real = await vi.importActual<typeof import('fs')>('fs')
  const isFakePath = (p: unknown) => typeof p === 'string' && (p.startsWith('/proj/') || p.startsWith('/fake/'))
  const defaultExistsSync = (p: unknown) => (isFakePath(p) ? false : real.existsSync(p as never))
  const defaultReadFileSync = (p: unknown, opts?: unknown) => {
    if (isFakePath(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return real.readFileSync(p as never, opts as never)
  }
  fsMock.defaultExistsSync = defaultExistsSync
  fsMock.defaultReadFileSync = defaultReadFileSync
  fsMock.existsSync = vi.fn(defaultExistsSync)
  fsMock.readFileSync = vi.fn(defaultReadFileSync)
  fsMock.writeFileSync = vi.fn()
  // project-repository.ts and paths.ts both use the default import
  // (`import fs from 'fs'`), so `default` must carry the SAME vi.fn
  // references as the named exports — otherwise a per-test
  // `vi.mocked(fs.readFileSync).mockImplementation(...)` silently mutates a
  // function the code under test never actually calls.
  return {
    ...real,
    default: { ...real, existsSync: fsMock.existsSync, readFileSync: fsMock.readFileSync, writeFileSync: fsMock.writeFileSync },
    existsSync: fsMock.existsSync,
    readFileSync: fsMock.readFileSync,
    writeFileSync: fsMock.writeFileSync,
  }
})

let createWorkbenchContext: typeof import('../workbench-context.js').createWorkbenchContext

beforeEach(async () => {
  vi.resetModules()
  // A test that overrides readFileSync's implementation (getCompileConfig
  // below) must not leak that override into later tests.
  fsMock.existsSync.mockClear().mockImplementation(fsMock.defaultExistsSync)
  fsMock.readFileSync.mockClear().mockImplementation(fsMock.defaultReadFileSync)
  fsMock.writeFileSync.mockClear()
  ;({ createWorkbenchContext } = await import('../workbench-context.js'))
})

function fakeMainWindow(): import('electron').BrowserWindow {
  const wc = {
    id: 1,
    isDestroyed: () => false,
    send: vi.fn(),
    getURL: () => '',
  }
  return { webContents: wc, isDestroyed: () => false } as unknown as import('electron').BrowserWindow
}

const PROJECT_PATH = '/proj/compile-modes'
const COMPILE_MODES_CHANGED = (ProjectChannel as unknown as Record<string, string>).CompileModesChanged

function makeProvider(initialStored: CompileModes = { current: -1, list: [] }) {
  let stored = initialStored
  return {
    listProjects: vi.fn(() => []),
    addProject: vi.fn(),
    removeProject: vi.fn(),
    getCompileModes: vi.fn(async () => stored),
    saveCompileModes: vi.fn(async (_path: string, next: CompileModes) => {
      stored = next
    }),
  }
}

function makeAdapter(appId = 'compile-modes-app') {
  return {
    openProject: vi.fn(async () => ({
      close: vi.fn(async () => {}),
      port: 12345,
      appInfo: { appId },
    })),
  }
}

function buildContext(provider: ReturnType<typeof makeProvider>, adapter: ReturnType<typeof makeAdapter>) {
  return createWorkbenchContext({
    mainWindow: fakeMainWindow(),
    preloadPath: '/fake/preload.js',
    rendererDir: '/fake/renderer',
    projectsProvider: provider,
    adapter,
  })
}

describe('WorkspaceService: getCompileModeState scoped to the currently open project', () => {
  it('has a snapshot for the just-opened project path', async () => {
    const ctx = buildContext(makeProvider(), makeAdapter())
    const opened = await ctx.workspace.openProject(PROJECT_PATH)
    expect(opened.success).toBe(true)

    const snapshot = ctx.workspace.getCompileModeState(PROJECT_PATH)
    expect(snapshot.revision).toBe(0)
    expect(snapshot.state).toEqual({ selectedId: null, entries: [] })
  })

  it('throws when asked for a path that is not the currently open project', async () => {
    const ctx = buildContext(makeProvider(), makeAdapter())
    await ctx.workspace.openProject(PROJECT_PATH)

    expect(() => ctx.workspace.getCompileModeState('/proj/some-other-project')).toThrow(
      /no compile-mode store open for \/proj\/some-other-project/,
    )
  })
})

describe('WorkspaceService: store changes are forwarded to the renderer', () => {
  it('applyCompileModeCommand pushes the resulting change through ctx.notify.compileModesChanged', async () => {
    const mainWindow = fakeMainWindow()
    const ctx = createWorkbenchContext({
      mainWindow,
      preloadPath: '/fake/preload.js',
      rendererDir: '/fake/renderer',
      projectsProvider: makeProvider(),
      adapter: makeAdapter(),
    })
    await ctx.workspace.openProject(PROJECT_PATH)
    vi.mocked(mainWindow.webContents.send).mockClear()

    const change = await ctx.workspace.applyCompileModeCommand({
      type: 'add',
      mode: { name: 'A', pathName: 'pages/a/a', query: '', scene: null },
    })

    expect(mainWindow.webContents.send).toHaveBeenCalledWith(COMPILE_MODES_CHANGED, change)
  })
})

describe('WorkspaceService: getCompileConfig fills startPage from the project entry page', () => {
  it('falls back to getProjectPages(path).entryPagePath when the selected mode has no startPage (普通编译)', async () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      if (String(filePath).endsWith('app.json')) {
        return JSON.stringify({ pages: ['pages/home/home'], entryPagePath: 'pages/home/home' })
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const ctx = buildContext(makeProvider(), makeAdapter())
    await ctx.workspace.openProject(PROJECT_PATH)

    const config = await ctx.workspace.getCompileConfig(PROJECT_PATH)
    expect(config.startPage).toBe('pages/home/home')
  })
})

describe('WorkspaceService: closeProject disposes the store', () => {
  it('rejects a subsequent applyCompileModeCommand and stops notifying after close', async () => {
    const mainWindow = fakeMainWindow()
    const ctx = createWorkbenchContext({
      mainWindow,
      preloadPath: '/fake/preload.js',
      rendererDir: '/fake/renderer',
      projectsProvider: makeProvider(),
      adapter: makeAdapter(),
    })
    await ctx.workspace.openProject(PROJECT_PATH)
    await ctx.workspace.closeProject()
    vi.mocked(mainWindow.webContents.send).mockClear()

    await expect(
      ctx.workspace.applyCompileModeCommand({
        type: 'add',
        mode: { name: 'A', pathName: 'pages/a/a', query: '', scene: null },
      }),
    ).rejects.toThrow(/compile-mode store/)
    expect(mainWindow.webContents.send).not.toHaveBeenCalledWith(COMPILE_MODES_CHANGED, expect.anything())
  })
})

describe('WorkspaceService: openProject failing after the store was created must not leak it', () => {
  it('a session with no valid appId fails rejectInvalidAppId — the store opened for it must not stay reachable', async () => {
    // A CompilationAdapter that resolves openProject but violates the
    // appInfo.appId contract — the existing openProject flow rejects this
    // AFTER the point the compile-mode store gets created, which is exactly
    // the "opened, then the overall open still failed" case the design
    // requires cleanup for.
    const adapter = {
      openProject: vi.fn(async () => ({
        close: vi.fn(async () => {}),
        port: 12345,
        appInfo: {}, // missing appId — rejectInvalidAppId fails this session
      })),
    }
    const ctx = buildContext(makeProvider(), adapter as never)

    const result = await ctx.workspace.openProject(PROJECT_PATH)
    expect(result.success).toBe(false)

    expect(() => ctx.workspace.getCompileModeState(PROJECT_PATH)).toThrow(
      /no compile-mode store open for/,
    )
  })
})

describe('WorkspaceService: a superseded openProject must not clobber the newer request\'s store', () => {
  it('leaves the newer request\'s committed store reachable when the superseded open\'s compile settles later', async () => {
    // Two projects opened back-to-back: A's adapter.openProject is held open
    // (this test controls when it resolves) so it settles AFTER B, whose
    // adapter.openProject resolves immediately and wins the op-lock race.
    let resolveA!: (session: { close: () => Promise<void>; port: number; appInfo: { appId: string } }) => void
    const sessionAPromise = new Promise<{ close: () => Promise<void>; port: number; appInfo: { appId: string } }>((resolve) => {
      resolveA = resolve
    })
    const closeA = vi.fn(async () => {})
    const closeB = vi.fn(async () => {})

    const openProject = vi.fn()
    openProject.mockImplementationOnce(() => sessionAPromise)
    openProject.mockImplementationOnce(async () => ({
      close: closeB,
      port: 22222,
      appInfo: { appId: 'proj-b-app' },
    }))
    const adapter = { openProject }
    const ctx = buildContext(makeProvider(), adapter as never)

    const a = ctx.workspace.openProject('/proj/a')
    await vi.waitFor(() => expect(openProject).toHaveBeenCalledTimes(1))

    const resultB = await ctx.workspace.openProject('/proj/b')
    expect(resultB.success).toBe(true)

    const snapshotBeforeAResolves = ctx.workspace.getCompileModeState('/proj/b')

    resolveA({ close: closeA, port: 11111, appInfo: { appId: 'proj-a-app' } })
    const resultA = await a
    expect(resultA.success).toBe(false)

    const snapshotAfter = ctx.workspace.getCompileModeState('/proj/b')
    expect(snapshotAfter.revision).toBe(snapshotBeforeAResolves.revision)
    expect(snapshotAfter.state).toEqual(snapshotBeforeAResolves.state)
    expect(closeA).toHaveBeenCalled()
  })
})
