/**
 * Contract: a watcher-triggered rebuild must republish the CURRENT page list
 * alongside the existing `hotReload:true` signal.
 *
 * Today `onRebuild` in workspace-service.ts is:
 *   `onRebuild: () => sendStatus('ready', '编译完成，已重启', true)`
 * — it never re-reads the project's pages, so a rebuild that adds/removes a
 * page (e.g. `pages/new` created after the initial open) leaves the
 * renderer's page list stale: the popover's 启动页面 dropdown and any other
 * pages-driven UI keep showing the pages captured at the FIRST compile.
 *
 * Fix under test: the rebuild-driven `project:status` payload must carry a
 * `pages` array that reflects a FRESH read of `repo.getProjectPages(projectPath)`
 * taken at rebuild time — not a value cached from the initial open. The test
 * proves freshness by changing what the (mocked) repository returns BETWEEN
 * `openProject` and firing the captured `onRebuild` callback, then asserting
 * the emitted payload matches the POST-change value.
 *
 * Pattern lifted from `workspace-hot-reload.test.ts` (hoisted electron/fs
 * stubs + a mocked project-repository + a captured onRebuild callback).
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

// `getProjectPages` is mutable per-test via `pagesToReturn` so the test can
// simulate the project's app.json changing between the initial open and the
// watcher rebuild.
const { pagesState } = vi.hoisted(() => ({
  pagesState: { pages: ['pages/index/index'], entryPagePath: 'pages/index/index' },
}))

vi.mock('../projects/project-repository.js', () => ({
  validateProjectDir: vi.fn(() => null),
  listProjects: vi.fn(() => []),
  addProject: vi.fn((p: string) => ({ name: 'fake', path: p })),
  removeProject: vi.fn(),
  hasProject: vi.fn(() => false),
  updateLastOpened: vi.fn(),
  getProjectPages: vi.fn(() => pagesState),
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
  pagesState.pages = ['pages/index/index']
  pagesState.entryPagePath = 'pages/index/index'
  ;({ createWorkspaceService } = await import('./workspace-service.js'))
})

describe('workspace-service: rebuild-driven status carries a freshly-read pages array', () => {
  it('emits the pages captured at REBUILD time, not the ones seen at the initial open', async () => {
    const projectStatus = vi.fn<(payload: ExpectedPayload) => void>()

    let capturedOnRebuild: (() => void) | null = null
    const fakeSession = {
      port: 12345,
      appInfo: { appId: 'fakeApp' },
      close: vi.fn(() => Promise.resolve()),
    }
    const adapter = {
      openProject: vi.fn(async (opts: { onRebuild?: () => void }) => {
        capturedOnRebuild = opts.onRebuild ?? null
        return fakeSession
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
    expect(capturedOnRebuild).toBeTypeOf('function')

    // Simulate the project's app.json gaining a page between the initial
    // open and the watcher's rebuild.
    pagesState.pages = ['pages/index/index', 'pages/new/new']
    pagesState.entryPagePath = 'pages/index/index'

    capturedOnRebuild!()

    const rebuildPayload =
      projectStatus.mock.calls[projectStatus.mock.calls.length - 1]![0] as ExpectedPayload

    expect(rebuildPayload).toEqual(
      expect.objectContaining({
        status: 'ready',
        hotReload: true,
        pages: ['pages/index/index', 'pages/new/new'],
      }),
    )
  })

  it('does not report the initial-open pages snapshot on the rebuild payload (regression guard)', async () => {
    const projectStatus = vi.fn<(payload: ExpectedPayload) => void>()
    let capturedOnRebuild: (() => void) | null = null
    const adapter = {
      openProject: vi.fn(async (opts: { onRebuild?: () => void }) => {
        capturedOnRebuild = opts.onRebuild ?? null
        return {
          port: 1,
          appInfo: { appId: 'a' },
          close: vi.fn(() => Promise.resolve()),
        }
      }),
    }
    const ctx = {
      adapter,
      notify: { projectStatus },
      views: { disposeAll: vi.fn() },
      projectsProvider: stubProjectsProvider(),
    } as unknown as WorkbenchContext

    const workspace = createWorkspaceService(ctx)
    await workspace.openProject('/tmp/fakeProj')

    pagesState.pages = ['pages/only-after-rebuild']
    capturedOnRebuild!()

    const rebuildPayload =
      projectStatus.mock.calls[projectStatus.mock.calls.length - 1]![0] as ExpectedPayload
    expect(rebuildPayload.pages).not.toEqual(['pages/index/index'])
    expect(rebuildPayload.pages).toEqual(['pages/only-after-rebuild'])
  })
})
