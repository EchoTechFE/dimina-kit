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
    detachWorkbench: vi.fn(() => events.push('views.detachWorkbench')),
    // The switch path also tears down the previous project's native simulator
    // WCV (and, via its destroyed hook, the bridge app session) so the
    // reopened project can't render the previous one.
    detachSimulator: vi.fn(() => events.push('views.detachSimulator')),
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

  it('openProject(B) while A is active tears down A\'s native simulator BEFORE the adapter opens B', async () => {
    const { ctx, views, events } = makeHarness()
    const workspace = createWorkspaceService(ctx)

    await workspace.openProject('/tmp/projA')
    await workspace.openProject('/tmp/projB')

    // Returning to the project list never calls closeProject (the back button
    // only notifies windowNavigateBack), so the switch is the ONLY hop that can
    // tear down the outgoing project's native simulator WCV + bridge session.
    // Without it the reopened project renders the PREVIOUS project: the old WCV
    // keeps painting it and resolveCurrentApp can resolve the stale session.
    expect(
      views.detachSimulator,
      'switching projects must detach the previous native simulator so the reopened '
      + 'project does not render the previous one',
    ).toHaveBeenCalledTimes(1)

    // The teardown must happen before B's adapter open, so A's WCV/bridge are
    // gone before B's simulator attaches and spawns.
    const detach = events.indexOf('views.detachSimulator')
    const openB = events.indexOf('open:/tmp/projB')
    expect(detach).toBeGreaterThanOrEqual(0)
    expect(openB).toBeGreaterThan(detach)
  })

  it('the FIRST openProject (no predecessor) does not detach a simulator', async () => {
    const { ctx, views } = makeHarness()
    const workspace = createWorkspaceService(ctx)

    await workspace.openProject('/tmp/projA')

    expect(
      views.detachSimulator,
      'the first open has no previous project — detaching would tear down the view '
      + 'the renderer is about to attach',
    ).not.toHaveBeenCalled()
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

/**
 * Helpers shared across the serialization + latest-wins suites below.
 * Both suites need a deferred adapter.openProject so they can control the
 * timing of concurrent lifecycle calls. We keep them local rather than
 * merging into makeHarness to avoid coupling the existing suite to the
 * new deferred-timing assumptions.
 */
function makeViewsSpy() {
  const events: string[] = []
  const views = {
    disposeAll: vi.fn(() => { events.push('views.disposeAll') }),
    detachWorkbench: vi.fn(() => { events.push('views.detachWorkbench') }),
    detachSimulator: vi.fn(() => { events.push('views.detachSimulator') }),
  }
  return { views, events }
}

function makeCtxWith(
  views: ReturnType<typeof makeViewsSpy>['views'],
  adapter: { openProject: ReturnType<typeof vi.fn> },
) {
  return {
    adapter,
    notify: { projectStatus: vi.fn(), compileLog: vi.fn() },
    views,
    projectsProvider: stubProjectsProvider(),
  } as unknown as WorkbenchContext
}

describe('workspace-service: open/close serialization (lifecycle ops must not interleave)', () => {
  /**
   * The zombie state: openProject(B) sets currentSession=B but closeProject()
   * has already called views.disposeAll — so the live session has no views to
   * render into. A serialized queue prevents this by ensuring closeProject runs
   * only after openProject's adapter await has fully committed or been aborted.
   *
   * Failure predicate: without serialization, closeProject() races the adapter
   * await and calls disposeAll while currentSession ends up set to B — the
   * assertion `views.disposeAll not called when B is live` catches the race.
   */
  it('concurrent openProject(B) + closeProject() do not produce zombie state (B live, views already disposed)', async () => {
    const { views, events } = makeViewsSpy()
    // Create the deferred promise BEFORE the adapter so resolveB is set
    // immediately (Promise constructor runs synchronously), not lazily inside
    // the adapter call that hasn't fired yet.
    let resolveB!: () => void
    const bDeferred = new Promise<void>((resolve) => { resolveB = resolve })
    const closedProjects: string[] = []
    const adapter = {
      openProject: vi.fn(async ({ projectPath }: { projectPath: string }) => {
        events.push(`adapter-start:${projectPath}`)
        if (projectPath === '/B') await bDeferred
        events.push(`adapter-end:${projectPath}`)
        return {
          port: 7788,
          appInfo: { appId: `app:${projectPath}` },
          close: vi.fn(async () => { closedProjects.push(projectPath) }),
        }
      }),
    }
    const ctx = makeCtxWith(views, adapter)
    const workspace = createWorkspaceService(ctx)

    await workspace.openProject('/A')

    // Fire both concurrently — B's adapter is deferred so the race window is
    // wide enough to let closeProject run while B is still pending.
    const openBPromise = workspace.openProject('/B')
    const closePromise = workspace.closeProject()
    resolveB()
    await Promise.all([openBPromise, closePromise])

    // Post-settle invariant: the session and views must be self-consistent.
    // Zombie = session live (B) + views already disposeAll'd.
    // Either terminal state is acceptable:
    //   (a) B is active → disposeAll must NOT have run yet
    //   (b) clean close → session cleared + disposeAll called once
    const finalSession = workspace.getSession()
    if (finalSession !== null) {
      expect(
        views.disposeAll,
        'disposeAll must not fire while B is the live active session — that is the zombie state',
      ).not.toHaveBeenCalled()
    } else {
      expect(
        views.disposeAll,
        'clean close terminal state must have disposed views exactly once',
      ).toHaveBeenCalledTimes(1)
    }
  })

  /**
   * Ordering constraint: when closeProject() races an openProject(B) that
   * has a slow adapter, disposeAll must not appear BEFORE B's adapter settles.
   * Firing disposeAll mid-adapter-await tears down views while B's setup is
   * still in flight — the same zombie root cause from a different angle.
   *
   * Failure predicate: without serialization, closeProject's disposeAll call
   * runs while the adapter awaits resolveB, so events.indexOf('views.disposeAll')
   * < events.indexOf('adapter-end:/B') — the assertion flips for red.
   */
  it('disposeAll does not fire in the middle of B adapter await (open/close event ordering)', async () => {
    const { views, events } = makeViewsSpy()
    let resolveB!: () => void
    const bDeferred = new Promise<void>((resolve) => { resolveB = resolve })
    const adapter = {
      openProject: vi.fn(async ({ projectPath }: { projectPath: string }) => {
        events.push(`adapter-start:${projectPath}`)
        if (projectPath === '/B') await bDeferred
        events.push(`adapter-end:${projectPath}`)
        return {
          port: 7788,
          appInfo: { appId: `app:${projectPath}` },
          close: vi.fn(async () => { events.push(`close:${projectPath}`) }),
        }
      }),
    }
    const ctx = makeCtxWith(views, adapter)
    const workspace = createWorkspaceService(ctx)

    await workspace.openProject('/A')

    const openBPromise = workspace.openProject('/B')
    const closePromise = workspace.closeProject()
    resolveB()
    await Promise.all([openBPromise, closePromise])

    const disposeIdx = events.indexOf('views.disposeAll')
    const adapterEndBIdx = events.indexOf('adapter-end:/B')

    // Only assert ordering when both events actually fired. If the serialized
    // implementation absorbs or cancels one branch (e.g. cancels B since close
    // follows), one index may be -1 — that is a valid serialized outcome.
    if (disposeIdx >= 0 && adapterEndBIdx >= 0) {
      expect(
        disposeIdx,
        'disposeAll must come AFTER adapter-end:/B — firing it earlier tears down '
        + 'views while B setup is in flight',
      ).toBeGreaterThan(adapterEndBIdx)
    }
  })

  /**
   * The adapter compile runs outside the serialization lock (between teardown
   * section-1 and commit section-2), so a permanently-hung adapter cannot
   * prevent a queued closeProject from acquiring the lock and running to
   * completion.
   *
   * Failure predicate: if the lock were held across the entire adapter await
   * (single-lock-wraps-all design), closeProject would be permanently blocked
   * behind the hung adapter and the test would time out waiting on closePromise.
   */
  it('a permanently-hung adapter.openProject does not block a queued closeProject (adapter compile runs outside the lock)', async () => {
    const { views } = makeViewsSpy()
    // Signals when B's teardown section has finished and the adapter call has
    // started — at that moment B holds no lock (teardown lock released via finally
    // before the adapter call begins).
    let signalBAdapterStarted!: () => void
    const bAdapterStarted = new Promise<void>((resolve) => { signalBAdapterStarted = resolve })
    const neverSettle = new Promise<never>(() => {})

    const adapter = {
      openProject: vi.fn(async ({ projectPath }: { projectPath: string }) => {
        if (projectPath === '/B') {
          signalBAdapterStarted() // teardown is done; adapter is now running outside the lock
          await neverSettle       // hangs indefinitely — simulates a stuck compile
        }
        return {
          port: 7788,
          appInfo: { appId: `app:${projectPath}` },
          close: vi.fn(async () => {}),
        }
      }),
    }
    const ctx = makeCtxWith(views, adapter)
    const workspace = createWorkspaceService(ctx)

    await workspace.openProject('/A')

    // openB's teardown section runs (closes A, releases teardown lock), then
    // the adapter call starts and hangs indefinitely — outside the lock.
    const openBPromise = workspace.openProject('/B')
    // Prevent an unhandled-rejection if openBPromise is superseded and rejects
    // or resolves with {success:false} after the test teardown ends.
    openBPromise.catch(() => {})

    // Wait until B's teardown has finished and the adapter hang has begun.
    // B holds no lock at this point.
    await bAdapterStarted

    // closeProject must acquire the teardown lock (B released it after section-1)
    // and run to completion without waiting for B's hung adapter.
    const closePromise = workspace.closeProject()
    await closePromise // hangs here forever if the lock still spans the adapter await

    expect(
      views.disposeAll,
      'closeProject must reach disposeAll — it must not be blocked by B\'s hung adapter',
    ).toHaveBeenCalledTimes(1)
  })
})

describe('workspace-service: latest-wins (concurrent open operations)', () => {
  /**
   * When two openProject calls are issued concurrently (the second before the
   * first's adapter resolves), the most-recently initiated project must become
   * the terminal active session. Without a serialization/cancellation queue the
   * last-to-resolve wins instead, which can be the FIRST initiated project if
   * its adapter happens to be slower — a non-deterministic session takeover.
   *
   * Failure predicate: without latest-wins, A (the last to resolve) overwrites
   * B (the last to initiate), so getSession().appInfo.appId === 'app:/A' —
   * the assertion catches the wrong winner.
   */
  it('last openProject(B) wins: final session is B when A was initiated first but resolved last', async () => {
    const { views, events } = makeViewsSpy()
    let resolveA!: () => void
    const aDeferred = new Promise<void>((resolve) => { resolveA = resolve })
    const closedProjects: string[] = []
    const adapter = {
      openProject: vi.fn(async ({ projectPath }: { projectPath: string }) => {
        events.push(`adapter-start:${projectPath}`)
        // A is slow: doesn't resolve until we call resolveA below.
        if (projectPath === '/A') await aDeferred
        events.push(`adapter-end:${projectPath}`)
        return {
          port: 7788,
          appInfo: { appId: `app:${projectPath}` },
          close: vi.fn(async () => { closedProjects.push(projectPath) }),
        }
      }),
    }
    const ctx = makeCtxWith(views, adapter)
    const workspace = createWorkspaceService(ctx)

    // Initiate A (slow) then immediately B (fast — resolves in the same tick).
    const openA = workspace.openProject('/A')
    const openB = workspace.openProject('/B')
    // Now unblock A; it resolves AFTER B has already settled.
    resolveA()
    await Promise.all([openA, openB])

    // Latest-wins: B was initiated last and must be the terminal session.
    // Without a queue, A (resolved last) overwrites currentSession → wrong winner.
    expect(
      (workspace.getSession()?.appInfo as { appId?: string } | undefined)?.appId,
      'the most-recently initiated project (B) must be the terminal active session',
    ).toBe('app:/B')

    // A must have been cleaned up — if A's adapter settled it established a
    // session that must be closed. A live A session beside B means two compile
    // workers for the same workspace.
    if (events.includes('adapter-end:/A')) {
      expect(
        closedProjects,
        'A\'s session must be closed after B takes over (no compile-worker leak)',
      ).toContain('/A')
    }
  })

  /**
   * The generation token is claimed after the veto hook resolves. When A is
   * initiated first with a slow hook and B is initiated second with a fast hook,
   * B's hook resolves first — B claims the lower generation, commits, and becomes
   * the active session. A's hook resolves later, giving A the higher generation.
   * At A's commit section the guard must detect that a newer committed session
   * (B's) is already live and discard A's freshly-opened session.
   *
   * Failure predicate: if the commit guard only compares myGen === opGeneration
   * but opGeneration was bumped by A itself after B committed, A passes the guard
   * and overwrites B — the assertion appId === 'app:/B' fails.
   */
  it('later-initiated open wins even when its veto hook resolves first: the earlier open\'s late hook must not overwrite the committed later session', async () => {
    const { views } = makeViewsSpy()
    let resolveAHook!: () => void
    const aHookDeferred = new Promise<void>((resolve) => { resolveAHook = resolve })
    const closedSessions: string[] = []

    const adapter = {
      openProject: vi.fn(async ({ projectPath }: { projectPath: string }) => {
        return {
          port: 7788,
          appInfo: { appId: `app:${projectPath}` },
          close: vi.fn(async () => { closedSessions.push(projectPath) }),
        }
      }),
    }

    // A's hook blocks; B's hook resolves immediately. Hook completion order is
    // the reverse of initiation order: B (second) resolves before A (first).
    const ctx = {
      ...makeCtxWith(views, adapter),
      onBeforeOpenProject: async (projectPath: string) => {
        if (projectPath === '/A') await aHookDeferred
        // B's hook returns immediately
      },
    } as unknown as import('../workbench-context.js').WorkbenchContext

    const workspace = createWorkspaceService(ctx)

    // Initiate A (slow hook) then B (fast hook) concurrently.
    const openAPromise = workspace.openProject('/A')
    const openBPromise = workspace.openProject('/B')

    // B's hook resolves immediately — wait for B to commit and become active.
    await openBPromise

    // Now release A's hook. A's request seq was claimed at initiation (before
    // its hook), so it is LOWER than B's; once B has taken ownership, A finds
    // itself superseded and bows out.
    resolveAHook()
    await openAPromise

    // B was initiated later (the second/later request) and must remain the
    // terminal active session. A's late hook completion must not let A overwrite B.
    expect(
      (workspace.getSession()?.appInfo as { appId?: string } | undefined)?.appId,
      'B (the later-initiated request) must be the terminal active session — '
      + 'A\'s slow hook resolving after B commits must not overwrite B',
    ).toBe('app:/B')

    // No leaked compile worker for A. Because A is superseded as soon as B owns
    // the runtime, A bows out BEFORE its adapter compile in the common case (so
    // it never opens a session at all); if it did open one, it must have been
    // closed. Either way A leaves nothing running alongside B.
    const aOpened = adapter.openProject.mock.calls.some(
      ([arg]: [{ projectPath: string }]) => arg.projectPath === '/A',
    )
    expect(
      !aOpened || closedSessions.includes('/A'),
      'A must not leak a compile worker: it is superseded before its adapter runs, '
      + 'or any session it opened is closed',
    ).toBe(true)
  })
})
