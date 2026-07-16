/**
 * onBeforeOpenProject PERMISSION HOOK (host-shell extensibility) —
 * workspace-service unit contract.
 *
 * Downstream hosts need to veto a project open before any side effect runs:
 * permission check, license gate, "you must log in first", etc. The contract:
 *
 *  - `openProject(path)` first `await ctx.onBeforeOpenProject?.(path)` —
 *    BEFORE its first current side effect (`clearSimulatorServicewechatReferer`)
 *    and BEFORE `disposeSession()` tears the old session down.
 *  - If the hook THROWS, openProject returns `{ success: false, error }`,
 *    the still-active OLD session is NOT disposed, and `ctx.adapter.openProject`
 *    is NEVER called. A denied open must have zero side effects.
 *  - If the hook is absent or resolves normally, behaviour is unchanged.
 *
 * Bug guarded against: the hook is wired AFTER disposeSession (so a denial
 * still nukes the user's current session), or the adapter is invoked despite
 * the veto (permission bypass), or the hook isn't awaited / isn't called at
 * all.
 *
 * Harness lifted from `workspace-session-teardown.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => {
  const app = { getPath: vi.fn(() => '/tmp/dimina-test-userdata'), isPackaged: true }
  const nativeTheme = { themeSource: 'system' }
  return { app, nativeTheme, default: {} }
})

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

function stubProjectsProvider(): import('../projects/types.js').ProjectsProvider {
  return {
    listProjects: vi.fn(() => []),
    addProject: vi.fn((p: string) => ({ name: 'fake', path: p, lastOpened: null })),
    removeProject: vi.fn(),
    validateProjectDir: vi.fn(() => null),
  }
}

type FakeSession = {
  port: number
  appInfo: { appId: string }
  close: ReturnType<typeof vi.fn>
}

/**
 * `onBeforeOpenProject` is a NEW optional field on WorkbenchContext. Until the
 * fix adds it to the type, assigning it on a typed ctx red-flags the contract.
 */
function makeHarness(opts?: {
  onBeforeOpenProject?: (projectPath: string) => void | Promise<void>
}) {
  const events: string[] = []
  const adapter = {
    openProject: vi.fn(async ({ projectPath }: { projectPath: string }) => {
      events.push(`adapter.open:${projectPath}`)
      const session: FakeSession = {
        port: 7788,
        appInfo: { appId: `app:${projectPath}` },
        close: vi.fn(async () => { events.push(`close:${projectPath}`) }),
      }
      return session
    }),
  }
  const views = { disposeAll: vi.fn(() => events.push('views.disposeAll')), holdWorkbenchAttach: vi.fn(() => vi.fn()) }
  const ctx = {
    adapter,
    notify: { projectStatus: vi.fn(), compileLog: vi.fn() },
    views,
    projectsProvider: stubProjectsProvider(),
    onBeforeOpenProject: opts?.onBeforeOpenProject,
  } as unknown as WorkbenchContext
  return { ctx, adapter, views, events }
}

beforeEach(async () => {
  vi.resetModules()
  ;({ createWorkspaceService } = await import('./workspace-service.js'))
})

describe('workspace-service: onBeforeOpenProject permission hook', () => {
  it('awaits the hook before any side effect and proceeds when it resolves', async () => {
    const order: string[] = []
    const onBeforeOpenProject = vi.fn(async (p: string) => {
      order.push(`hook:${p}`)
    })
    const { ctx, adapter, events } = makeHarness({ onBeforeOpenProject })
    const workspace = createWorkspaceService(ctx)

    const result = await workspace.openProject('/tmp/projA')

    expect(result.success).toBe(true)
    expect(onBeforeOpenProject).toHaveBeenCalledTimes(1)
    expect(onBeforeOpenProject).toHaveBeenCalledWith('/tmp/projA')
    expect(adapter.openProject).toHaveBeenCalledTimes(1)

    // The hook must run BEFORE the adapter is asked to open.
    const adapterOpen = events.indexOf('adapter.open:/tmp/projA')
    expect(adapterOpen).toBeGreaterThanOrEqual(0)
    // hook resolved before the adapter open was recorded
    expect(order).toEqual(['hook:/tmp/projA'])
  })

  it('a THROWING hook denies the open: returns {success:false}, NEVER calls the adapter', async () => {
    const onBeforeOpenProject = vi.fn(async () => {
      throw new Error('permission denied: please log in first')
    })
    const { ctx, adapter } = makeHarness({ onBeforeOpenProject })
    const workspace = createWorkspaceService(ctx)

    const result = await workspace.openProject('/tmp/secret')

    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
    expect(result.error).toContain('permission denied')
    expect(
      adapter.openProject,
      'a vetoed open must NOT reach the adapter — that is the permission bypass we guard',
    ).not.toHaveBeenCalled()
  })

  it('a THROWING hook surfaces the veto to the status bar (symmetry with validateProjectDir rejection)', async () => {
    const onBeforeOpenProject = vi.fn(async () => {
      throw new Error('permission denied: please log in first')
    })
    const { ctx } = makeHarness({ onBeforeOpenProject })
    const workspace = createWorkspaceService(ctx)

    const result = await workspace.openProject('/tmp/secret')

    expect(result.success).toBe(false)
    // A host veto must reach the user the same way validateProjectDir rejection
    // does: an error status bar carrying the thrown Error's message. Otherwise
    // the open silently fails with no UI feedback.
    expect(
      ctx.notify.projectStatus,
      'a vetoed open must emit an error projectStatus so the status bar tells the user why',
    ).toHaveBeenCalledWith({ status: 'error', message: 'permission denied: please log in first' })
  })

  it('a THROWING hook does NOT dispose the currently-active session (denial has zero side effects)', async () => {
    // First, establish an active session with a permissive hook.
    let deny = false
    const onBeforeOpenProject = vi.fn(async () => {
      if (deny) throw new Error('denied')
    })
    const { ctx, adapter, views } = makeHarness({ onBeforeOpenProject })
    const workspace = createWorkspaceService(ctx)

    const first = await workspace.openProject('/tmp/projA')
    expect(first.success).toBe(true)
    expect(workspace.hasActiveSession()).toBe(true)
    const activeSession = workspace.getSession()
    const adapterCallsAfterOpen = adapter.openProject.mock.calls.length
    const disposeAllAfterOpen = views.disposeAll.mock.calls.length

    // Now a denied switch to B.
    deny = true
    const second = await workspace.openProject('/tmp/projB')
    expect(second.success).toBe(false)

    expect(
      workspace.hasActiveSession(),
      'a denied open must leave the ORIGINAL session intact — wiring the hook after disposeSession '
      + 'would nuke the user\'s current project even when the new open is rejected',
    ).toBe(true)
    expect(workspace.getSession()).toBe(activeSession)
    expect((workspace.getSession()!.appInfo as { appId: string }).appId).toBe('app:/tmp/projA')
    // No further adapter open, no views teardown happened on the denied path.
    expect(adapter.openProject.mock.calls.length).toBe(adapterCallsAfterOpen)
    expect(views.disposeAll.mock.calls.length).toBe(disposeAllAfterOpen)
  })

  it('no hook present → behaviour unchanged (open succeeds, adapter called)', async () => {
    const { ctx, adapter } = makeHarness()
    const workspace = createWorkspaceService(ctx)

    const result = await workspace.openProject('/tmp/projA')
    expect(result.success).toBe(true)
    expect(adapter.openProject).toHaveBeenCalledTimes(1)
  })
})
