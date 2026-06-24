/**
 * LEAK-PROOFING WAVE (项目关闭时保证编译子进程同步关闭) — devtools conduction
 * layer, workspace-service unit contract.
 *
 * The devkit side guarantees `session.close()` truly kills the forked
 * compile worker (see devkit `compile-worker-leak.test.ts`). This file pins
 * that the devtools workspace-service actually DELIVERS `session.close()` on
 * every project-teardown path it owns:
 *
 *  - `closeProject()` → the adapter session's close() is awaited exactly
 *    once, the active session is cleared, and views are disposed AFTER the
 *    session close settled (kill the compiler before tearing down the UI it
 *    reports into).
 *  - `closeProject()` is idempotent — no double-close of the same session.
 *  - `openProject(B)` while A is active → A's close() fully settles BEFORE
 *    the adapter is asked to open B (two live compile workers for one
 *    workspace is the switch-leak).
 *  - a rejecting `session.close()` must not wedge the teardown: the session
 *    is still cleared and views still disposed.
 *
 * Existing-coverage note (checked before writing): the only prior pin on
 * `session.close` was the appId-validation rejection path
 * (`workspace-open-project-appinfo-validation.test.ts:153`); the
 * close/switch/teardown paths above were unpinned.
 *
 * Harness pattern lifted from `workspace-hot-reload.test.ts` (electron + fs
 * + project-repository mocks, lazy import, minimal fake WorkbenchContext).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── electron stub ────────────────────────────────────────────────────────
vi.mock('electron', () => {
  const app = {
    getPath: vi.fn(() => '/tmp/dimina-test-userdata'),
    isPackaged: true,
  }
  const nativeTheme = { themeSource: 'system' }
  return { app, nativeTheme, default: {} }
})

// Settings reads all ENOENT so defaults kick in (loadWorkbenchSettings).
vi.mock('fs', async () => {
  const real = await vi.importActual<typeof import('fs')>('fs')
  const readFileSync = vi.fn(() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })
  const existsSync = vi.fn(() => false)
  const writeFileSync = vi.fn()
  const mkdirSync = vi.fn()
  const mocked = {
    ...real,
    readFileSync,
    existsSync,
    writeFileSync,
    mkdirSync,
  }
  return { ...mocked, default: mocked }
})

vi.mock('../projects/project-repository.js', () => ({
  validateProjectDir: vi.fn(() => null),
  listProjects: vi.fn(() => []),
  addProject: vi.fn((p: string) => ({ name: 'fake', path: p })),
  removeProject: vi.fn(),
  hasProject: vi.fn(() => false),
  updateLastOpened: vi.fn(),
  getProjectPages: vi.fn(() => ({ pages: [], entryPagePath: '' })),
  getCompileConfig: vi.fn(() => ({ startPage: '', scene: 1011, queryParams: [] })),
  saveCompileConfig: vi.fn(),
  getProjectSettings: vi.fn(() => ({ uploadWithSourceMap: false })),
  updateProjectSettings: vi.fn(),
}))

type WorkbenchContext = import('../workbench-context.js').WorkbenchContext
let createWorkspaceService: typeof import('./workspace-service.js').createWorkspaceService

function stubProjectsProvider(): import('../projects/types.js').ProjectsProvider {
  return {
    listProjects: vi.fn(() => []),
    addProject: vi.fn((p: string) => ({ name: 'fake', path: p, lastOpened: null })),
    removeProject: vi.fn(),
  }
}

type FakeSession = {
  port: number
  appInfo: { appId: string }
  close: ReturnType<typeof vi.fn>
}

/**
 * Build a fake adapter whose sessions log their close into `events` and a
 * context exposing the pieces workspace-service touches. `closeBehavior`
 * lets a test make a specific session's close slow or rejecting.
 */
function makeHarness(opts?: {
  closeBehavior?: (projectPath: string) => Promise<void>
}) {
  const events: string[] = []
  const sessions = new Map<string, FakeSession>()
  const adapter = {
    openProject: vi.fn(async ({ projectPath }: { projectPath: string }) => {
      events.push(`open:${projectPath}`)
      const session: FakeSession = {
        port: 7788,
        appInfo: { appId: `app:${projectPath}` },
        close: vi.fn(async () => {
          events.push(`close-begin:${projectPath}`)
          if (opts?.closeBehavior) await opts.closeBehavior(projectPath)
          events.push(`close-end:${projectPath}`)
        }),
      }
      sessions.set(projectPath, session)
      return session
    }),
  }
  const views = {
    disposeAll: vi.fn(() => events.push('views.disposeAll')),
    // The switch path (openProject while a session is active) detaches the
    // embedded workbench editor so it re-mirrors the incoming project.
    detachWorkbench: vi.fn(),
  }
  const ctx = {
    adapter,
    notify: { projectStatus: vi.fn(), compileLog: vi.fn() },
    views,
    projectsProvider: stubProjectsProvider(),
  } as unknown as WorkbenchContext
  return { ctx, adapter, views, events, sessions }
}

beforeEach(async () => {
  vi.resetModules()
  ;({ createWorkspaceService } = await import('./workspace-service.js'))
})

describe('workspace-service: closeProject delivers session.close (compile-worker teardown conduction)', () => {
  it('closeProject() awaits session.close exactly once, clears the session, and disposes views only AFTER close settled', async () => {
    const { ctx, events, sessions } = makeHarness()
    const workspace = createWorkspaceService(ctx)

    const result = await workspace.openProject('/tmp/projA')
    expect(result.success).toBe(true)
    expect(workspace.hasActiveSession()).toBe(true)

    await workspace.closeProject()

    const session = sessions.get('/tmp/projA')!
    expect(
      session.close,
      'closeProject must call the adapter session close — this is the ONLY hop that reaches '
      + 'devkit and kills the forked compile worker',
    ).toHaveBeenCalledTimes(1)
    expect(workspace.hasActiveSession()).toBe(false)
    expect(workspace.getSession()).toBeNull()

    // Ordering: the compiler must be dead before the UI it reports into is
    // torn down — disposeAll first would leave a window where worker output
    // targets disposed views.
    const closeEnd = events.indexOf('close-end:/tmp/projA')
    const disposeAll = events.indexOf('views.disposeAll')
    expect(closeEnd, 'session close must have settled').toBeGreaterThanOrEqual(0)
    expect(disposeAll, 'views.disposeAll must have run during closeProject').toBeGreaterThanOrEqual(0)
    expect(
      disposeAll,
      'views.disposeAll must run AFTER session.close settled',
    ).toBeGreaterThan(closeEnd)
  })

  it('closeProject() is idempotent — the second call never closes the same session twice', async () => {
    const { ctx, sessions } = makeHarness()
    const workspace = createWorkspaceService(ctx)
    await workspace.openProject('/tmp/projA')

    await workspace.closeProject()
    await workspace.closeProject()

    expect(
      sessions.get('/tmp/projA')!.close,
      'double closeProject must not double-close: the second close() could race a devkit instance '
      + 'that already re-used resources',
    ).toHaveBeenCalledTimes(1)
  })

  it('openProject(B) while A is active: A.close() SETTLES before the adapter is asked to open B (no two live compile workers)', async () => {
    // Make close take a real macrotask so an unawaited disposeSession would
    // observably let open:B jump the queue.
    const { ctx, events, sessions } = makeHarness({
      closeBehavior: () => new Promise((resolve) => setTimeout(resolve, 0)),
    })
    const workspace = createWorkspaceService(ctx)

    await workspace.openProject('/tmp/projA')
    const resultB = await workspace.openProject('/tmp/projB')
    expect(resultB.success).toBe(true)

    expect(
      sessions.get('/tmp/projA')!.close,
      'switching projects must close the OLD session — otherwise every switch leaks one '
      + 'compile worker + dev server',
    ).toHaveBeenCalledTimes(1)

    const closeEndA = events.indexOf('close-end:/tmp/projA')
    const openB = events.indexOf('open:/tmp/projB')
    expect(closeEndA).toBeGreaterThanOrEqual(0)
    expect(openB).toBeGreaterThanOrEqual(0)
    expect(
      openB,
      'A\'s close must fully SETTLE before B opens — overlapping sessions mean two live '
      + 'compile workers for one workspace',
    ).toBeGreaterThan(closeEndA)

    // And the new session must be the active one.
    expect(workspace.hasActiveSession()).toBe(true)
    expect((workspace.getSession()!.appInfo as { appId: string }).appId).toBe('app:/tmp/projB')
  })

  it('a REJECTING session.close() must not wedge teardown: session cleared, views still disposed', async () => {
    const { ctx, views, sessions } = makeHarness({
      closeBehavior: () => Promise.reject(new Error('close blew up')),
    })
    const workspace = createWorkspaceService(ctx)
    await workspace.openProject('/tmp/projA')

    await expect(
      workspace.closeProject(),
      'closeProject must not rethrow a session-close failure — callers (window close, app dispose) '
      + 'treat it as fire-and-forget teardown',
    ).resolves.toBeUndefined()

    expect(sessions.get('/tmp/projA')!.close).toHaveBeenCalledTimes(1)
    expect(
      workspace.hasActiveSession(),
      'even when close() rejects the session must be dropped — keeping a half-dead session makes '
      + 'every later teardown path skip it (hasActiveSession guards) and the worker leaks for good',
    ).toBe(false)
    expect(views.disposeAll).toHaveBeenCalledTimes(1)
  })
})
