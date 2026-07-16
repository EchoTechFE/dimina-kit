/**
 * `workspace-service.ts`'s `runCompile` must gate BOTH the file watcher and
 * the simulator auto-reload independently on the split settings
 * (`compile.autoBuild`, `preview.autoReload`) instead of the old single
 * `compile.watch` flag:
 *  - `adapter.openProject` receives `watch: settings.compile.autoBuild` AND
 *    a new `autoReload: settings.preview.autoReload` option, so a
 *    downstream `CompilationAdapter` can honor "recompile on save" and
 *    "reload the simulator" as two independently-togglable behaviors.
 *  - The `onRebuild` callback wired into `openProject` dispatches
 *    `hotReload: settings.preview.autoReload` — when the developer has
 *    turned auto-reload off, the post-rebuild status must NOT claim
 *    `hotReload: true` (that would make the renderer reload the webview
 *    even though the user asked it not to).
 *
 * Pattern lifted from `workspace-hot-reload.test.ts`: hoist stub state so
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
type WorkbenchContext = import('../workbench-context.js').WorkbenchContext
type OpenProjectOpts = {
  watch?: boolean
  autoReload?: boolean
  onRebuild?: () => void
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
 * assertions need: the captured `openProject` opts, the captured
 * `onRebuild` hook, and the `projectStatus` spy.
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
  const ctx = {
    adapter,
    notify: { projectStatus },
    views: { disposeAll: vi.fn(), holdWorkbenchAttach: vi.fn(() => vi.fn()) },
    projectsProvider: stubProjectsProvider(),
  } as unknown as WorkbenchContext

  const workspace = createWorkspaceService(ctx)
  const result = await workspace.openProject('/tmp/fakeProj')
  expect(result.success).toBe(true)

  return { capturedOpts: capturedOpts as OpenProjectOpts | null, projectStatus }
}

describe('workspace-service: runCompile gates watch AND simulator auto-reload independently', () => {
  it('passes watch:false and autoReload:false through to the adapter, and a rebuild does not claim hotReload:true, when both settings are off', async () => {
    const { capturedOpts, projectStatus } = await openProjectWithSettings({
      compile: { autoBuild: false },
      preview: { autoReload: false },
    })

    expect(capturedOpts).not.toBeNull()
    expect(capturedOpts!.watch).toBe(false)
    expect(capturedOpts!.autoReload).toBe(false)

    expect(capturedOpts!.onRebuild).toBeTypeOf('function')
    capturedOpts!.onRebuild!()

    const rebuildPayload =
      projectStatus.mock.calls[projectStatus.mock.calls.length - 1]![0] as ExpectedPayload
    expect(rebuildPayload.hotReload).not.toBe(true)
  })

  it('passes watch:true and autoReload:true through to the adapter, and a rebuild dispatches hotReload:true, when both settings are on', async () => {
    const { capturedOpts, projectStatus } = await openProjectWithSettings({
      compile: { autoBuild: true },
      preview: { autoReload: true },
    })

    expect(capturedOpts).not.toBeNull()
    expect(capturedOpts!.watch).toBe(true)
    expect(capturedOpts!.autoReload).toBe(true)

    expect(capturedOpts!.onRebuild).toBeTypeOf('function')
    capturedOpts!.onRebuild!()

    const rebuildPayload =
      projectStatus.mock.calls[projectStatus.mock.calls.length - 1]![0] as ExpectedPayload
    expect(rebuildPayload).toEqual(
      expect.objectContaining({
        status: 'ready',
        hotReload: true,
      }),
    )
  })
})
