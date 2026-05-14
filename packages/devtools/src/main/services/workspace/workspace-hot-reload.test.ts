/**
 * TDD-style failing test for the upcoming "auto-reload simulator on watch
 * rebuild" fix.
 *
 * Contract under test (NOT yet implemented):
 *  - `ExpectedPayload` will gain an optional `hotReload?: boolean` flag.
 *  - The `onRebuild` callback wired in `workspace-service.ts` will dispatch
 *    `projectStatus({ status: 'ready', message: '编译完成，已热更新', hotReload: true })`
 *    so the renderer can call `webview.reload()` once the watcher-triggered
 *    rebuild is complete.
 *  - The initial-open path (`正在编译...` → `编译完成`) must still emit WITHOUT
 *    `hotReload`, so the simulator is not double-reloaded right after the
 *    first compile finishes.
 *
 * This test is expected to FAIL today (production currently emits
 * `{ status: 'ready', message: '编译完成，已热更新' }` with no `hotReload`).
 *
 * Pattern lifted from `src/main/app/close-with-active-session.test.ts`:
 *  - hoist stub state so `vi.mock('electron', …)` can see it
 *  - lazily import `createWorkspaceService` after the mocks are installed
 *  - inject a fake `WorkbenchContext` with the minimal slice the service needs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── electron stub ────────────────────────────────────────────────────────
// `loadWorkbenchSettings` (imported by workspace-service.ts) pulls in `app`
// and `nativeTheme` from electron at module-evaluation time; we mock both so
// nothing real is required.
vi.mock('electron', () => {
  const app = {
    getPath: vi.fn(() => '/tmp/dimina-test-userdata'),
    isPackaged: true,
  }
  const nativeTheme = { themeSource: 'system' }
  return { app, nativeTheme, default: {} }
})

// fs is used by both project-repository (which we mock below) and
// workbench-settings (loadWorkbenchSettings).  Keep the real fs but make
// every settings read return ENOENT so defaults kick in.
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

// Mock the project-repository module to bypass disk I/O and let
// `workspace.openProject` accept any path. We only need `validateProjectDir`
// to return null and the other repository methods to no-op.
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

// ── Lazy imports ────────────────────────────────────────────────────────
//
// We deliberately define a LOCAL payload shape with an OPTIONAL `hotReload`
// field instead of importing `ExpectedPayload` from the notifier. The
// implementation will extend the real `ExpectedPayload` with this same
// field, but until then the upstream type lacks `hotReload` and reading it
// off the imported type would be a typecheck error. Using a structural local
// type lets the tests compile today while still asserting the contract.
type ExpectedPayload = {
  status: string
  message: string
  hotReload?: boolean
}
type WorkbenchContext = import('../workbench-context.js').WorkbenchContext
let createWorkspaceService: typeof import('./workspace-service.js').createWorkspaceService

beforeEach(async () => {
  vi.resetModules()
  ;({ createWorkspaceService } = await import('./workspace-service.js'))
})

describe('workspace-service: file-watcher rebuild emits hotReload signal', () => {
  it('captures the onRebuild callback handed to the adapter and emits hotReload:true when fired', async () => {
    const projectStatus = vi.fn<(payload: ExpectedPayload) => void>()

    // Capture the onRebuild callback the workspace service passes to the
    // adapter. Tests need to invoke it manually to simulate the watcher
    // firing a rebuild AFTER the initial open has finished.
    let capturedOnRebuild: (() => void) | null = null
    const fakeSession = {
      port: 12345,
      appInfo: { appId: 'fakeApp' },
      close: vi.fn(() => Promise.resolve()),
    }
    const adapter = {
      openProject: vi.fn(
        async (opts: { onRebuild?: () => void }) => {
          capturedOnRebuild = opts.onRebuild ?? null
          return fakeSession
        },
      ),
    }

    const ctx = {
      adapter,
      notify: { projectStatus },
      views: { disposeAll: vi.fn() },
    } as unknown as WorkbenchContext

    const workspace = createWorkspaceService(ctx)

    const result = await workspace.openProject('/tmp/fakeProj')
    expect(result.success).toBe(true)

    // Make sure we actually got the watcher hook from openProject.
    expect(capturedOnRebuild).toBeTypeOf('function')

    // Snapshot the initial-open calls so we can specifically assert NONE of
    // them carry hotReload:true (otherwise the renderer would always reload
    // immediately after the very first compile, defeating the point).
    const initialCalls = projectStatus.mock.calls.map((c) => c[0])
    for (const payload of initialCalls) {
      expect(
        (payload as ExpectedPayload).hotReload,
        `initial-open status ${JSON.stringify(payload)} must NOT carry hotReload:true`,
      ).not.toBe(true)
    }

    // Now simulate a watcher-triggered rebuild.
    capturedOnRebuild!()

    // The most recent projectStatus call must be the rebuild-driven one,
    // and must carry hotReload:true so the renderer knows to reload the
    // webview.
    const rebuildPayload =
      projectStatus.mock.calls[projectStatus.mock.calls.length - 1]![0] as ExpectedPayload
    expect(rebuildPayload).toEqual(
      expect.objectContaining({
        status: 'ready',
        hotReload: true,
      }),
    )
  })

  it('initial-open path stays free of hotReload (regression guard)', async () => {
    const projectStatus = vi.fn<(payload: ExpectedPayload) => void>()
    const adapter = {
      openProject: vi.fn(async () => ({
        port: 1,
        appInfo: { appId: 'a' },
        close: vi.fn(() => Promise.resolve()),
      })),
    }
    const ctx = {
      adapter,
      notify: { projectStatus },
      views: { disposeAll: vi.fn() },
    } as unknown as WorkbenchContext

    const workspace = createWorkspaceService(ctx)
    await workspace.openProject('/tmp/fakeProj')

    // Find the 'ready' call with message '编译完成' (the final initial-open
    // call before any watcher activity). That call must NOT carry hotReload.
    const readyCompletedCalls = projectStatus.mock.calls
      .map((c) => c[0] as ExpectedPayload)
      .filter((p) => p.status === 'ready' && p.message === '编译完成')

    expect(readyCompletedCalls.length).toBeGreaterThanOrEqual(1)
    for (const payload of readyCompletedCalls) {
      expect(payload.hotReload).not.toBe(true)
    }
  })
})
