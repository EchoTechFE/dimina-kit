/**
 * workspace-service wiring for the workbench attach gate: `openProject` holds
 * the gate immediately after taking ownership of its request token (before the
 * adapter compile starts) and releases it at each of the three early-exit
 * points plus the normal compile-settle path, so the embedded editor's heavy
 * WebContentsView never fights the boot-critical teardown + first-compile
 * window for CPU. A vetoed open (onBeforeOpenProject throws) never holds the
 * gate at all — the hold is claimed strictly after ownership, which the veto
 * precedes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { stubProjectsProvider } from './workspace-lifecycle-race.testutil.js'

// ── electron stub ────────────────────────────────────────────────────────
vi.mock('electron', () => {
  const app = { getPath: vi.fn(() => '/tmp/dimina-test-userdata'), isPackaged: true }
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
  const mocked = { ...real, readFileSync, existsSync, writeFileSync, mkdirSync }
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

beforeEach(async () => {
  vi.resetModules()
  ;({ createWorkspaceService } = await import('./workspace-service.js'))
})

/**
 * A views spy whose `holdWorkbenchAttach` records each call and hands back a
 * distinct release spy per call (recorded in `releases`, in call order) —
 * lets a test tell apart a superseded request's hold from the request that
 * ultimately commits.
 */
function makeViewsSpyWithGate() {
  const events: string[] = []
  const releases: Array<ReturnType<typeof vi.fn>> = []
  const views = {
    disposeAll: vi.fn(() => { events.push('views.disposeAll') }),
    disposeProjectViews: vi.fn(() => { events.push('views.disposeProjectViews') }),
    detachWorkbench: vi.fn(() => { events.push('views.detachWorkbench') }),
    detachSimulator: vi.fn(() => { events.push('views.detachSimulator') }),
    holdWorkbenchAttach: vi.fn(() => {
      events.push('views.holdWorkbenchAttach')
      const release = vi.fn(() => { events.push('views.releaseWorkbenchAttach') })
      releases.push(release)
      return release
    }),
    // Close-path veto over an in-flight (or stale) hold: teardown paths must
    // invalidate the gate WITHOUT replaying it, so a late release/cap from the
    // request the hold belonged to can never rebuild a zombie workbench view.
    cancelWorkbenchAttachHold: vi.fn(() => { events.push('views.cancelWorkbenchAttachHold') }),
  }
  return { views, events, releases }
}

function makeCtx(
  views: ReturnType<typeof makeViewsSpyWithGate>['views'],
  adapter: { openProject: ReturnType<typeof vi.fn> },
  extra?: { onBeforeOpenProject?: (p: string) => void | Promise<void>; projectsProvider?: import('../projects/types.js').ProjectsProvider },
): WorkbenchContext {
  return {
    adapter,
    notify: { projectStatus: vi.fn(), compileLog: vi.fn() },
    views,
    projectsProvider: extra?.projectsProvider ?? stubProjectsProvider(),
    onBeforeOpenProject: extra?.onBeforeOpenProject,
  } as unknown as WorkbenchContext
}

// The adapter receives an options object; the behavior only cares about the
// project path, so unwrap it here to keep event labels path-keyed.
function makeSessionAdapter(behavior: (projectPath: string) => Promise<unknown>) {
  return { openProject: vi.fn((opts: { projectPath: string }) => behavior(opts.projectPath)) }
}

describe('workspace-service: workbench attach gate wiring', () => {
  it('holds the gate before the compile starts and releases it only after the compile settles', async () => {
    const { views, events } = makeViewsSpyWithGate()
    let resolveAdapter!: () => void
    const deferred = new Promise<void>((resolve) => { resolveAdapter = resolve })
    const adapter = makeSessionAdapter(async (projectPath) => {
      events.push(`adapter-start:${projectPath}`)
      await deferred
      events.push(`adapter-end:${projectPath}`)
      return { port: 7788, appInfo: { appId: `app:${projectPath}` }, close: vi.fn() }
    })
    const workspace = createWorkspaceService(makeCtx(views, adapter))

    const openPromise = workspace.openProject('/A')
    // Let the microtask queue run the veto-less synchronous prefix (ownership +
    // hold + teardown) before releasing the deferred adapter.
    await Promise.resolve()
    await Promise.resolve()
    resolveAdapter()
    await openPromise

    expect(views.holdWorkbenchAttach, 'openProject must hold the gate exactly once').toHaveBeenCalledTimes(1)
    const releaseSpy = views.holdWorkbenchAttach.mock.results[0]?.value as ReturnType<typeof vi.fn> | undefined
    expect(releaseSpy, 'holdWorkbenchAttach must return a release function').toBeDefined()
    expect(releaseSpy, 'openProject must release the gate exactly once').toHaveBeenCalledTimes(1)

    const holdIdx = events.indexOf('views.holdWorkbenchAttach')
    const adapterStartIdx = events.indexOf('adapter-start:/A')
    const adapterEndIdx = events.indexOf('adapter-end:/A')
    const releaseIdx = events.indexOf('views.releaseWorkbenchAttach')

    expect(holdIdx, 'the hold must be recorded').toBeGreaterThanOrEqual(0)
    expect(adapterStartIdx, 'the compile must have started').toBeGreaterThanOrEqual(0)
    expect(releaseIdx, 'the release must be recorded').toBeGreaterThanOrEqual(0)

    expect(holdIdx, 'hold precedes the compile start').toBeLessThan(adapterStartIdx)
    expect(releaseIdx, 'release follows the compile settle').toBeGreaterThan(adapterEndIdx)
  })

  it('a failing compile still releases the gate', async () => {
    const { views } = makeViewsSpyWithGate()
    const adapter = makeSessionAdapter(async () => {
      throw new Error('compile failed')
    })
    const workspace = createWorkspaceService(makeCtx(views, adapter))

    const result = await workspace.openProject('/A')

    expect(result.success).toBe(false)
    expect(views.holdWorkbenchAttach, 'the gate must be held even though the compile fails').toHaveBeenCalledTimes(1)
    const releaseSpy = views.holdWorkbenchAttach.mock.results[0]?.value as ReturnType<typeof vi.fn> | undefined
    expect(releaseSpy, 'a failed compile must still release the gate').toHaveBeenCalledTimes(1)
  })

  it('the dirError early exit releases the gate without ever reaching the compile adapter', async () => {
    const { views } = makeViewsSpyWithGate()
    const adapter = makeSessionAdapter(async (projectPath) => ({
      port: 7788,
      appInfo: { appId: `app:${projectPath}` },
      close: vi.fn(),
    }))
    const projectsProvider: import('../projects/types.js').ProjectsProvider = {
      ...stubProjectsProvider(),
      validateProjectDir: vi.fn(() => 'not a mini-program project'),
    }
    const workspace = createWorkspaceService(makeCtx(views, adapter, { projectsProvider }))

    const result = await workspace.openProject('/bad-project')

    expect(result.success).toBe(false)
    expect(
      adapter.openProject,
      'a rejected project dir must never reach the compile adapter',
    ).not.toHaveBeenCalled()
    expect(views.holdWorkbenchAttach, 'the gate is held before the dir check').toHaveBeenCalledTimes(1)
    const releaseSpy = views.holdWorkbenchAttach.mock.results[0]?.value as ReturnType<typeof vi.fn> | undefined
    expect(releaseSpy, 'the dirError branch must release the gate').toHaveBeenCalledTimes(1)
  })

  it('a vetoing onBeforeOpenProject hook prevents the gate from ever being held', async () => {
    const { views } = makeViewsSpyWithGate()
    const adapter = makeSessionAdapter(async (projectPath) => ({
      port: 7788,
      appInfo: { appId: `app:${projectPath}` },
      close: vi.fn(),
    }))
    const onBeforeOpenProject = vi.fn(async () => {
      throw new Error('permission denied')
    })
    const workspace = createWorkspaceService(makeCtx(views, adapter, { onBeforeOpenProject }))

    const result = await workspace.openProject('/tmp/secret')

    expect(result.success).toBe(false)
    expect(
      views.holdWorkbenchAttach,
      'ownership (and the hold that follows it) is only claimed AFTER the veto hook resolves — '
      + 'a throwing hook must never reach it',
    ).not.toHaveBeenCalled()
  })

  it('the superseded early exit in runOpenTeardown releases the superseded request\'s own hold', async () => {
    const { views, releases } = makeViewsSpyWithGate()
    const adapter = makeSessionAdapter(async (projectPath) => ({
      port: 7788,
      appInfo: { appId: `app:${projectPath}` },
      close: vi.fn(),
    }))
    const workspace = createWorkspaceService(makeCtx(views, adapter))

    // Fire A then B with no await between them: the op-lock's FIFO acquire
    // queues A's teardown-section ahead of B's, but B claims ownership first
    // (both takeOwnership calls run synchronously before either teardown
    // section acquires the lock), so A discovers it is superseded the moment
    // its own teardown section runs.
    const openAPromise = workspace.openProject('/A')
    const openBPromise = workspace.openProject('/B')
    const [resultA, resultB] = await Promise.all([openAPromise, openBPromise])

    expect(resultA.success, 'A must bow out as superseded').toBe(false)
    expect(resultA.error).toContain('superseded')
    expect(resultB.success, 'B must be the terminal session').toBe(true)

    expect(views.holdWorkbenchAttach, 'both requests must hold the gate once each').toHaveBeenCalledTimes(2)
    expect(releases.length).toBe(2)
    const [releaseA] = releases
    expect(
      releaseA,
      'the superseded request (A) must release ITS OWN hold from the runOpenTeardown early exit',
    ).toHaveBeenCalledTimes(1)
  })

  it('a rejecting validateProjectDir is treated as a dirError: openProject resolves {success:false}, releases the gate once, and never reaches the compile adapter', async () => {
    const { views } = makeViewsSpyWithGate()
    const adapter = makeSessionAdapter(async (projectPath) => ({
      port: 7788,
      appInfo: { appId: `app:${projectPath}` },
      close: vi.fn(),
    }))
    const projectsProvider: import('../projects/types.js').ProjectsProvider = {
      ...stubProjectsProvider(),
      validateProjectDir: vi.fn(async () => {
        throw new Error('provider exploded')
      }),
    }
    const workspace = createWorkspaceService(makeCtx(views, adapter, { projectsProvider }))

    const result = await workspace.openProject('/flaky-project')

    expect(result.success, 'a rejecting validateProjectDir must resolve as a dirError, not reject openProject').toBe(false)
    expect(result.error).toContain('provider exploded')
    expect(
      adapter.openProject,
      'a rejecting validateProjectDir must never reach the compile adapter',
    ).not.toHaveBeenCalled()
    expect(views.holdWorkbenchAttach, 'the gate is held before the dir check runs').toHaveBeenCalledTimes(1)
    const releaseSpy = views.holdWorkbenchAttach.mock.results[0]?.value as ReturnType<typeof vi.fn> | undefined
    expect(releaseSpy, 'the rejecting-dirError path must release the gate exactly once').toHaveBeenCalledTimes(1)
  })

  it('closeProject preempting an in-flight open cancels the gate before disposeProjectViews, and the open\'s own late release is a harmless no-op', async () => {
    const { views, events } = makeViewsSpyWithGate()
    let resolveAdapter!: () => void
    const deferred = new Promise<void>((resolve) => { resolveAdapter = resolve })
    const adapter = makeSessionAdapter(async (projectPath) => {
      events.push(`adapter-start:${projectPath}`)
      await deferred
      events.push(`adapter-end:${projectPath}`)
      return { port: 7788, appInfo: { appId: `app:${projectPath}` }, close: vi.fn() }
    })
    const workspace = createWorkspaceService(makeCtx(views, adapter))

    const openPromise = workspace.openProject('/A')
    // Wait until the compile has actually started (the hold+teardown prefix
    // clears the op lock across several microtask hops) before racing close.
    for (let i = 0; i < 20 && !events.includes('adapter-start:/A'); i++) {
      await Promise.resolve()
    }
    expect(events, 'the compile must be in flight before close races it').toContain('adapter-start:/A')

    await workspace.closeProject()

    expect(
      views.cancelWorkbenchAttachHold,
      'closeProject must cancel the in-flight open\'s hold before tearing down project views',
    ).toHaveBeenCalledTimes(1)
    const cancelIdx = events.indexOf('views.cancelWorkbenchAttachHold')
    const disposeIdx = events.indexOf('views.disposeProjectViews')
    expect(cancelIdx).toBeGreaterThanOrEqual(0)
    expect(disposeIdx).toBeGreaterThanOrEqual(0)
    expect(cancelIdx, 'cancel precedes disposeProjectViews').toBeLessThan(disposeIdx)

    // The compile settles afterward; the open's own (now-canceled) release
    // still fires at its usual settle site and must not throw.
    resolveAdapter()
    await expect(openPromise).resolves.not.toThrow()
    const releaseSpy = views.holdWorkbenchAttach.mock.results[0]?.value as ReturnType<typeof vi.fn> | undefined
    expect(releaseSpy, 'the open\'s own release still fires normally after cancel — idempotent, no error').toHaveBeenCalledTimes(1)
  })

  it('closeProject superseded by a newer openProject never cancels the gate (that hold belongs to the newer request)', async () => {
    const { views } = makeViewsSpyWithGate()
    const adapter = makeSessionAdapter(async (projectPath) => ({
      port: 7788,
      appInfo: { appId: `app:${projectPath}` },
      close: vi.fn(),
    }))
    const workspace = createWorkspaceService(makeCtx(views, adapter))

    // closeProject claims its request token first, but a newer openProject
    // fired right behind it snatches ownership before close's critical
    // section runs — close must bow out without touching the gate.
    const closePromise = workspace.closeProject()
    const openPromise = workspace.openProject('/B')
    await Promise.all([closePromise, openPromise])

    expect(
      views.cancelWorkbenchAttachHold,
      'a superseded close must never cancel a hold — it does not own it',
    ).not.toHaveBeenCalled()
  })
})
