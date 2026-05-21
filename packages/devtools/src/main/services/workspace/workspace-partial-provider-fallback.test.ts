/**
 * Phase 1.5 contract: when a host (e.g. qdmp) injects a `ProjectsProvider`
 * that implements only the required methods (list/add/remove) and omits the
 * optional ones (`validateProjectDir` / `getCompileConfig` /
 * `saveCompileConfig`), `WorkspaceService` MUST NOT silently fall back to
 * the local filesystem helpers in `project-repository`. For a remote
 * provider the project path may not exist on this machine at all, so
 * touching `~/.config/Dimina/...` or `fs.existsSync(dirPath)` is
 * semantically wrong — it leaks the local single-tenant defaults into the
 * extensibility surface and silently bypasses the host.
 *
 * Each test below installs a provider with the optional method omitted,
 * spies on `fs` to assert it stays untouched, and pins the documented
 * default-shape behaviour from `projects-provider-review.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Project } from '../projects/project-repository.js'
import { DEFAULT_COMPILE_CONFIG } from '../projects/index.js'

// Electron stub — workspace-service indirectly pulls in modules that import
// from 'electron'. The stub only needs to not throw on `app.getPath`.
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/userdata'),
    isPackaged: true,
  },
  webContents: { fromId: vi.fn(() => null) },
  default: {},
}))

// IMPORTANT: every fs entry point the local fallback might use is spied on.
// Each test asserts these stay at zero calls.
vi.mock('fs', async () => {
  const real = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...real,
    default: real,
    existsSync: vi.fn(() => false),
    statSync: vi.fn(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }),
    readFileSync: vi.fn(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  }
})

let createWorkbenchContext: typeof import('../workbench-context.js').createWorkbenchContext
let fs: typeof import('fs')

beforeEach(async () => {
  vi.resetModules()
  ;({ createWorkbenchContext } = await import('../workbench-context.js'))
  fs = await import('fs')
  vi.mocked(fs.existsSync).mockClear()
  vi.mocked(fs.statSync).mockClear()
  vi.mocked(fs.readFileSync).mockClear()
  vi.mocked(fs.writeFileSync).mockClear()
  vi.mocked(fs.mkdirSync).mockClear()
})

function fakeMainWindow(): import('electron').BrowserWindow {
  const wc = { id: 1, isDestroyed: () => false, send: vi.fn(), getURL: () => '' }
  return { webContents: wc } as unknown as import('electron').BrowserWindow
}

const sampleProject: Project = { name: 'x', path: '/p/x', lastOpened: null }

function makePartialProvider() {
  return {
    listProjects: vi.fn(() => [sampleProject]),
    addProject: vi.fn((p: string) => ({ ...sampleProject, path: p })),
    removeProject: vi.fn(),
  }
}

describe('workspace-service ↔ partial ProjectsProvider (optional-method fallback)', () => {
  /**
   * Bug caught: workspace-service falls back to the local repo helper
   * `validateProjectDir`, which calls `fs.existsSync(dirPath)` against a
   * remote-only path. For a qdmp provider the path is never on disk, so
   * the host's "添加项目" click reports "目录不存在" even though the
   * remote workspace accepts it.
   */
  it('omits validateProjectDir → workspace returns null without touching fs', async () => {
    const injected = makePartialProvider()
    const ctx = createWorkbenchContext({
      mainWindow: fakeMainWindow(),
      preloadPath: '/fake/preload.js',
      rendererDir: '/fake/renderer',
      projectsProvider: injected,
    })

    const result = await ctx.workspace.validateProjectDir('/some/path')
    expect(result).toBeNull()
    expect(fs.existsSync).not.toHaveBeenCalled()
    expect(fs.statSync).not.toHaveBeenCalled()
    expect(fs.readFileSync).not.toHaveBeenCalled()
  })

  /**
   * Bug caught: workspace-service falls back to repo.getCompileConfig,
   * which reads `<userData>/dimina-projects.json` from local fs. A remote
   * provider therefore receives an empty-or-stale local-disk config
   * instead of the documented default shape; the simulator boots with
   * undefined `startPage` and renders blank.
   */
  it('omits getCompileConfig → workspace returns DEFAULT_COMPILE_CONFIG without touching fs', async () => {
    const injected = makePartialProvider()
    const ctx = createWorkbenchContext({
      mainWindow: fakeMainWindow(),
      preloadPath: '/fake/preload.js',
      rendererDir: '/fake/renderer',
      projectsProvider: injected,
    })

    const cfg = await ctx.workspace.getCompileConfig('/p/x')
    expect(cfg).toEqual(DEFAULT_COMPILE_CONFIG)
    expect(fs.existsSync).not.toHaveBeenCalled()
    expect(fs.readFileSync).not.toHaveBeenCalled()
  })

  /**
   * Bug caught: workspace-service falls back to repo.saveCompileConfig,
   * which writes to `<userData>/dimina-projects.json`. For a remote
   * provider this both (a) persists data the host never sees and (b)
   * litters the local user's config with phantom remote projects. The
   * correct behaviour is a silent no-op when the host opted out.
   */
  it('omits saveCompileConfig → workspace no-ops; nothing is written to fs and subsequent reads still return default', async () => {
    const injected = makePartialProvider()
    const ctx = createWorkbenchContext({
      mainWindow: fakeMainWindow(),
      preloadPath: '/fake/preload.js',
      rendererDir: '/fake/renderer',
      projectsProvider: injected,
    })

    const cfg = { startPage: 'pages/x', scene: 1001, queryParams: [] }
    await expect(ctx.workspace.saveCompileConfig('/p/x', cfg)).resolves.not.toThrow()
    expect(fs.writeFileSync).not.toHaveBeenCalled()
    expect(fs.mkdirSync).not.toHaveBeenCalled()

    // Persistence didn't happen, so the next read still surfaces the default.
    expect(await ctx.workspace.getCompileConfig('/p/x')).toEqual(DEFAULT_COMPILE_CONFIG)
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  /**
   * Regression guard: when the host DOES implement the optional method,
   * workspace-service must call it (and only it). Catches a fix that
   * over-corrects by always returning defaults and ignoring the provider.
   */
  it('implements getCompileConfig → workspace delegates to the provider, not the default', async () => {
    const hostCfg = {
      startPage: 'custom',
      scene: 9999,
      queryParams: [{ key: 'k', value: 'v' }],
    }
    const injected = {
      ...makePartialProvider(),
      getCompileConfig: vi.fn(() => hostCfg),
    }
    const ctx = createWorkbenchContext({
      mainWindow: fakeMainWindow(),
      preloadPath: '/fake/preload.js',
      rendererDir: '/fake/renderer',
      projectsProvider: injected,
    })

    const cfg = await ctx.workspace.getCompileConfig('/p/x')
    expect(cfg).toEqual(hostCfg)
    expect(injected.getCompileConfig).toHaveBeenCalledTimes(1)
    expect(injected.getCompileConfig).toHaveBeenCalledWith('/p/x')
    expect(fs.existsSync).not.toHaveBeenCalled()
    expect(fs.readFileSync).not.toHaveBeenCalled()
  })
})
