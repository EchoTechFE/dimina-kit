/**
 * `workspace-service.ts`'s `runCompile`'s `onRebuild` callback now receives an
 * optional `info: { changedPaths: string[]; styleOnly: boolean }` and, when the
 * rebuild was style-only AND the simulator auto-reload setting is on AND
 * `ctx.views.refreshSimulatorStyles()` succeeds (returns `true`), hot-swaps the
 * render-host stylesheets in place instead of the full "recompile + respawn"
 * path: it sends `status:'ready'`, message `'样式已热更新'`, and does NOT set
 * `hotReload: true` (the renderer must not bump its reload token / respawn the
 * DeviceShell for a style-only change — that would drop page-stack/form state
 * for no reason). Any other case (non-style change, auto-reload off, or the
 * style-hot-swap itself failing because there's no live render guest yet)
 * falls through to the existing full-reload path with `hotReload:
 * preview.autoReload`.
 *
 * Pattern lifted from `workspace-autoreload-gate.test.ts`: hoist stub state so
 * `vi.mock('electron', …)` / `vi.mock('fs', …)` can see it, mock the
 * project-repository module to bypass disk I/O, and lazily import
 * `createWorkspaceService` per test AFTER swapping in the settings fixture
 * `fs.readFileSync` should return.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => {
  const app = {
    getPath: vi.fn(() => '/tmp/dimina-test-userdata'),
    isPackaged: true,
  }
  const nativeTheme = { themeSource: 'system' }
  return { app, nativeTheme, default: {} }
})

const { readFileSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
}))

vi.mock('fs', async () => {
  const real = await vi.importActual<typeof import('fs')>('fs')
  const mocked = {
    ...real,
    readFileSync: readFileSyncMock,
    existsSync: vi.fn(() => false),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
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

type ExpectedPayload = {
  status: string
  message: string
  hotReload?: boolean
}
type RebuildInfo = { changedPaths: string[]; styleOnly: boolean }
type WorkbenchContext = import('../workbench-context.js').WorkbenchContext
type OpenProjectOpts = {
  watch?: boolean
  autoReload?: boolean
  onRebuild?: (info?: RebuildInfo) => void
}

function stubProjectsProvider(): import('../projects/types.js').ProjectsProvider {
  return {
    listProjects: vi.fn(() => []),
    addProject: vi.fn((p: string) => ({ name: 'fake', path: p, lastOpened: null })),
    removeProject: vi.fn(),
  }
}

/**
 * Boots a fresh `createWorkspaceService` with `fs.readFileSync` fixed to the
 * given settings JSON, opens a fake project, and returns everything the
 * assertions need: the captured `openProject` opts (including `onRebuild`),
 * the `projectStatus` spy, and the `refreshSimulatorStyles` mock so each test
 * can control its return value before invoking `onRebuild`.
 */
async function openProjectWithSettings(settingsJson: unknown) {
  vi.resetModules()
  readFileSyncMock.mockReset()
  readFileSyncMock.mockReturnValue(JSON.stringify(settingsJson))

  const { createWorkspaceService } = await import('./workspace-service.js')

  const projectStatus = vi.fn<(payload: ExpectedPayload) => void>()
  let capturedOpts: OpenProjectOpts | null = null
  const fakeSession = {
    port: 12345,
    appInfo: { appId: 'fakeApp' },
    close: vi.fn(() => Promise.resolve()),
  }
  const adapter = {
    openProject: vi.fn(async (opts: OpenProjectOpts) => {
      capturedOpts = opts
      return fakeSession
    }),
  }
  const refreshSimulatorStyles = vi.fn()
  const ctx = {
    adapter,
    notify: { projectStatus },
    views: { disposeAll: vi.fn(), refreshSimulatorStyles, holdWorkbenchAttach: vi.fn(() => vi.fn()) },
    projectsProvider: stubProjectsProvider(),
  } as unknown as WorkbenchContext

  const workspace = createWorkspaceService(ctx)
  const result = await workspace.openProject('/tmp/fakeProj')
  expect(result.success).toBe(true)

  return {
    capturedOpts: capturedOpts as OpenProjectOpts | null,
    projectStatus,
    refreshSimulatorStyles,
  }
}

function lastPayload(projectStatus: ReturnType<typeof vi.fn<(payload: ExpectedPayload) => void>>): ExpectedPayload {
  return projectStatus.mock.calls[projectStatus.mock.calls.length - 1]![0]
}

describe('workspace-service: runCompile onRebuild dispatches style-only hot reload vs full reload', () => {
  it('style-only rebuild + refreshSimulatorStyles() succeeds hot-swaps styles instead of a full reload', async () => {
    const { capturedOpts, projectStatus, refreshSimulatorStyles } = await openProjectWithSettings({
      compile: { autoBuild: true },
      preview: { autoReload: true },
    })
    refreshSimulatorStyles.mockReturnValue(true)

    expect(capturedOpts!.onRebuild).toBeTypeOf('function')
    capturedOpts!.onRebuild!({ changedPaths: ['a/b/page.wxss'], styleOnly: true })

    expect(refreshSimulatorStyles).toHaveBeenCalledTimes(1)
    const payload = lastPayload(projectStatus)
    expect(payload.message).toBe('样式已热更新')
    expect(payload.hotReload).not.toBe(true)
  })

  it('style-only rebuild but refreshSimulatorStyles() fails falls back to a full reload', async () => {
    const { capturedOpts, projectStatus, refreshSimulatorStyles } = await openProjectWithSettings({
      compile: { autoBuild: true },
      preview: { autoReload: true },
    })
    refreshSimulatorStyles.mockReturnValue(false)

    capturedOpts!.onRebuild!({ changedPaths: ['a/b/page.wxss'], styleOnly: true })

    expect(refreshSimulatorStyles).toHaveBeenCalledTimes(1)
    const payload = lastPayload(projectStatus)
    expect(payload.hotReload).toBe(true)
  })

  it('non-style-only rebuild never attempts the style hot-swap and does a full reload', async () => {
    const { capturedOpts, projectStatus, refreshSimulatorStyles } = await openProjectWithSettings({
      compile: { autoBuild: true },
      preview: { autoReload: true },
    })

    capturedOpts!.onRebuild!({ changedPaths: ['a/b/page.js'], styleOnly: false })

    expect(refreshSimulatorStyles).not.toHaveBeenCalled()
    const payload = lastPayload(projectStatus)
    expect(payload.hotReload).toBe(true)
  })

  it('style-only rebuild with simulator auto-reload OFF never attempts the style hot-swap', async () => {
    const { capturedOpts, projectStatus, refreshSimulatorStyles } = await openProjectWithSettings({
      compile: { autoBuild: true },
      preview: { autoReload: false },
    })

    capturedOpts!.onRebuild!({ changedPaths: ['a/b/page.wxss'], styleOnly: true })

    expect(refreshSimulatorStyles).not.toHaveBeenCalled()
    const payload = lastPayload(projectStatus)
    expect(payload.hotReload).not.toBe(true)
  })

  it('onRebuild called with no info arg is treated as a non-style rebuild', async () => {
    const { capturedOpts, projectStatus, refreshSimulatorStyles } = await openProjectWithSettings({
      compile: { autoBuild: true },
      preview: { autoReload: true },
    })

    capturedOpts!.onRebuild!()

    expect(refreshSimulatorStyles).not.toHaveBeenCalled()
    const payload = lastPayload(projectStatus)
    expect(payload.hotReload).toBe(true)
  })
})
