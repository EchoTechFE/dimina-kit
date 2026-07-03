/**
 * Contract: `workspace-service` wires devkit's new `onWatcherError` hook
 * (see devkit's `open-project-watcher-error-callback.test.ts`) into a
 * `project:status` push carrying `watcher: 'dead'`. A dead watcher is a
 * NON-FATAL degradation — auto-rebuild-on-save stopped working, but the
 * currently-running compiled output is still perfectly usable — so `status`
 * stays whatever it already was (not `'error'`); only the new `watcher` field
 * flips, so the UI can show a "auto-reload isn't working, reopen the
 * project" hint without treating the whole session as broken.
 *
 * Today `runCompile` builds the adapter.openProject options with
 * `onRebuild`/`onBuildError`/`onLog` but no `onWatcherError` — a watcher that
 * dies mid-session (see the devkit bug above) has no path to the renderer at
 * all.
 *
 * Pattern lifted from workspace-status-pages-refresh.test.ts (hoisted
 * electron/fs stubs + a mocked adapter capturing the options
 * `ctx.adapter.openProject` was called with).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => {
  const app = {
    getPath: vi.fn(() => '/tmp/dimina-test-userdata'),
    isPackaged: true,
  }
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
  getProjectPages: vi.fn(() => ({ pages: ['pages/index/index'], entryPagePath: 'pages/index/index' })),
  getCompileConfig: vi.fn(() => ({ startPage: '', scene: 1011, queryParams: [] })),
  saveCompileConfig: vi.fn(),
  getProjectSettings: vi.fn(() => ({ uploadWithSourceMap: false })),
  updateProjectSettings: vi.fn(),
}))

type ExpectedPayload = {
  status: string
  message: string
  hotReload?: boolean
  pages?: string[]
  watcher?: 'dead'
}
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

function makeSession() {
  return {
    port: 12345,
    appInfo: { appId: 'fakeApp' },
    close: vi.fn(() => Promise.resolve()),
  }
}

describe('workspace-service: a devkit onWatcherError callback surfaces watcher:"dead" (non-fatal)', () => {
  it('captures onWatcherError as an option passed to ctx.adapter.openProject', async () => {
    const adapter = {
      openProject: vi.fn(async (_opts: { onWatcherError?: (err: unknown) => void }) => makeSession()),
    }
    const ctx = {
      adapter,
      notify: { projectStatus: vi.fn() },
      views: { disposeAll: vi.fn() },
      projectsProvider: stubProjectsProvider(),
    } as unknown as WorkbenchContext

    const workspace = createWorkspaceService(ctx)
    await workspace.openProject('/tmp/fakeProj')

    const passedOpts = adapter.openProject.mock.calls[0]![0]
    expect(
      typeof passedOpts.onWatcherError,
      'workspace-service must pass an onWatcherError callback into devkit openProject so a dead watcher is observable',
    ).toBe('function')
  })

  it('pushes project:status with watcher:"dead" and status UNCHANGED (non-fatal) when onWatcherError fires', async () => {
    const projectStatus = vi.fn<(payload: ExpectedPayload) => void>()
    let capturedOnWatcherError: ((err: unknown) => void) | null = null
    const adapter = {
      openProject: vi.fn(async (opts: { onWatcherError?: (err: unknown) => void }) => {
        capturedOnWatcherError = opts.onWatcherError ?? null
        return makeSession()
      }),
    }
    const ctx = {
      adapter,
      notify: { projectStatus },
      views: { disposeAll: vi.fn() },
      projectsProvider: stubProjectsProvider(),
    } as unknown as WorkbenchContext

    const workspace = createWorkspaceService(ctx)
    const result = await workspace.openProject('/tmp/fakeProj')
    expect(result.success).toBe(true)
    expect(capturedOnWatcherError, 'onWatcherError must have been captured by the adapter call').toBeTypeOf('function')

    const callsBefore = projectStatus.mock.calls.length
    capturedOnWatcherError!(new Error('EMFILE: too many open files, watch'))

    expect(
      projectStatus.mock.calls.length,
      'a dead watcher must push a NEW project:status payload',
    ).toBeGreaterThan(callsBefore)

    const payload = projectStatus.mock.calls[projectStatus.mock.calls.length - 1]![0] as ExpectedPayload
    expect(payload.watcher, `expected watcher:'dead' on the pushed payload; got: ${JSON.stringify(payload)}`).toBe('dead')
    expect(
      payload.status,
      'a dead watcher is a non-fatal degradation — status must not flip to "error"',
    ).not.toBe('error')
  })

  it('does not carry watcher:"dead" on the normal open-success payload (regression guard)', async () => {
    const projectStatus = vi.fn<(payload: ExpectedPayload) => void>()
    const adapter = {
      openProject: vi.fn(async () => makeSession()),
    }
    const ctx = {
      adapter,
      notify: { projectStatus },
      views: { disposeAll: vi.fn() },
      projectsProvider: stubProjectsProvider(),
    } as unknown as WorkbenchContext

    const workspace = createWorkspaceService(ctx)
    await workspace.openProject('/tmp/fakeProj')

    for (const call of projectStatus.mock.calls) {
      expect((call[0] as ExpectedPayload).watcher).toBeUndefined()
    }
  })
})
