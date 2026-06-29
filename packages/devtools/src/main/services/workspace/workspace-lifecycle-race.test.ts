// Concurrent lifecycle contracts: serialization, latest-wins, isClosing guard.
// Timing-sensitive paths where multiple open/close operations overlap.
// Harness separated from workspace-session-teardown.test.ts to avoid coupling
// the leak-proofing suite to deferred-adapter timing assumptions.
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

beforeEach(async () => {
  vi.resetModules()
  ;({ createWorkspaceService } = await import('./workspace-service.js'))
})

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

// Minimal harness for the isClosing tests: sessions whose close() calls the given behavior.
function makeClosingHarness(closeBehavior: () => Promise<void>) {
  const adapter = {
    openProject: vi.fn(async ({ projectPath }: { projectPath: string }) => ({
      port: 7788,
      appInfo: { appId: `app:${projectPath}` },
      close: vi.fn(closeBehavior),
    })),
  }
  const views = {
    disposeAll: vi.fn(),
    detachWorkbench: vi.fn(),
    detachSimulator: vi.fn(),
  }
  return {
    ctx: {
      adapter,
      notify: { projectStatus: vi.fn(), compileLog: vi.fn() },
      views,
      projectsProvider: stubProjectsProvider(),
    } as unknown as WorkbenchContext,
  }
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

describe('workspace-service: isClosing flag tracks the closeProject teardown boundary', () => {
  /**
   * WorkspaceService must expose isClosing() so resolveCurrentApp can suppress
   * the stale-session fallback during the teardown window. The flag must be true
   * from the moment closeProject() begins its critical section (before
   * disposeSession() awaits session.close()) through to the end of teardown, and
   * false after closeProject() resolves.
   *
   * Failure predicate:
   *   - If isClosing() does not exist on the returned service, the typeof check
   *     fails ('undefined' !== 'function').
   *   - If isClosing() exists but returns false mid-teardown, the second expect
   *     (closingObservation === true) fails — the guard would never fire during
   *     the actual teardown window.
   *   - If isClosing() stays true after closeProject() resolves, the third
   *     expect (isClosing() === false) fails — every subsequent call would be
   *     treated as if teardown were still in progress.
   */
  it('isClosing() returns true during disposeSession and false after closeProject resolves', async () => {
    let closingObservation: boolean | undefined
    const ref: { ws?: ReturnType<typeof createWorkspaceService> } = {}

    const { ctx } = makeClosingHarness(async () => {
      // Runs inside close(), which closeProject() awaits — teardown is active.
      const ws = ref.ws as unknown as { isClosing?: () => boolean } | undefined
      closingObservation = typeof ws?.isClosing === 'function' ? ws.isClosing() : undefined
    })
    const workspace = createWorkspaceService(ctx)
    ref.ws = workspace

    await workspace.openProject('/tmp/projA')
    await workspace.closeProject()

    const ws = workspace as unknown as { isClosing?: () => boolean }
    expect(
      typeof ws.isClosing,
      'WorkspaceService must expose isClosing() — resolveCurrentApp reads it to guard the teardown window',
    ).toBe('function')
    expect(
      closingObservation,
      'isClosing() must return true while disposeSession() is awaited inside closeProject()',
    ).toBe(true)
    expect(
      ws.isClosing?.(),
      'isClosing() must return false after closeProject() has fully resolved',
    ).toBe(false)
  })

  /**
   * isClosing() must remain false during a normal openProject — that path has
   * no teardown of the workspace-service's own session state (it calls
   * disposeSession but only to clear the OLD session, not as a "close"
   * operation visible externally). Only closeProject transitions through the
   * closing window.
   *
   * Failure predicate: if isClosing() is incorrectly true during openProject's
   * disposeSession leg, the first expect fails — the resolveCurrentApp guard
   * would suppress session resolution even while a valid open is in progress.
   */
  it('isClosing() is false during openProject (teardown flag is scoped to closeProject only)', async () => {
    let closingDuringOpen: boolean | undefined
    const ref: { ws?: ReturnType<typeof createWorkspaceService> } = {}

    const { ctx } = makeClosingHarness(async () => {
      // Fires during the disposeSession inside openProject(B) when A is the predecessor.
      const ws = ref.ws as unknown as { isClosing?: () => boolean } | undefined
      closingDuringOpen = typeof ws?.isClosing === 'function' ? ws.isClosing() : undefined
    })
    const workspace = createWorkspaceService(ctx)
    ref.ws = workspace

    // Open A first so openProject(B) triggers disposeSession (for A).
    await workspace.openProject('/tmp/projA')
    await workspace.openProject('/tmp/projB')

    expect(
      closingDuringOpen,
      'isClosing() must be false during the disposeSession leg of openProject — '
      + 'only closeProject is a "close" from the workspace\'s perspective',
    ).toBe(false)
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
