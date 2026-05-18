/**
 * Phase 1 contract: workspace-service must delegate project-list operations
 * to the injected ProjectsProvider on the workbench context, falling back
 * to LocalProjectsProvider when no injection is supplied.
 *
 * Bugs each test would catch:
 *  - If workspace-service still calls the static `project-repository`
 *    functions directly, the injected provider's listProjects/addProject/
 *    removeProject/validateProjectDir would never be reached, and host
 *    extensions (qdmp) would be silently bypassed.
 *  - If `createWorkbenchContext` no longer instantiates a default
 *    LocalProjectsProvider when host omits `projectsProvider`, every
 *    existing single-tenant install regresses (list comes up empty / add
 *    throws null-pointer).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Project } from '../projects/project-repository.js'

// Minimal Electron stub — workspace-service indirectly imports modules that
// import from 'electron' (loadWorkbenchSettings, referer helpers). The stub
// just needs to not throw.
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/userdata'),
    isPackaged: true,
  },
  webContents: { fromId: vi.fn(() => null) },
  default: {},
}))

vi.mock('fs', async () => {
  const real = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...real,
    default: real,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }),
    writeFileSync: vi.fn(),
  }
})

let createWorkbenchContext: typeof import('../workbench-context.js').createWorkbenchContext
let createWorkspaceService: typeof import('./workspace-service.js').createWorkspaceService

beforeEach(async () => {
  vi.resetModules()
  ;({ createWorkbenchContext } = await import('../workbench-context.js'))
  ;({ createWorkspaceService } = await import('./workspace-service.js'))
})

function fakeMainWindow(): import('electron').BrowserWindow {
  const wc = {
    id: 1,
    isDestroyed: () => false,
    send: vi.fn(),
    getURL: () => '',
  }
  return { webContents: wc } as unknown as import('electron').BrowserWindow
}

describe('workspace-service ↔ ProjectsProvider injection', () => {
  it('delegates list/add/remove/validateProjectDir to the injected provider', async () => {
    const sampleProject: Project = {
      name: 'mock-app',
      path: '/proj/mock',
      lastOpened: null,
    }
    const injected = {
      listProjects: vi.fn(() => [sampleProject]),
      addProject: vi.fn((p: string) => ({ ...sampleProject, path: p })),
      removeProject: vi.fn(),
      validateProjectDir: vi.fn(() => null),
      updateLastOpened: vi.fn(),
    }

    const ctx = createWorkbenchContext({
      mainWindow: fakeMainWindow(),
      preloadPath: '/fake/preload.js',
      rendererDir: '/fake/renderer',
      projectsProvider: injected,
    })

    // Sanity: the workspace service was wired up using the injected provider.
    expect(await ctx.workspace.listProjects()).toEqual([sampleProject])
    expect(injected.listProjects).toHaveBeenCalledTimes(1)

    const added = await ctx.workspace.addProject('/proj/new')
    expect(added.path).toBe('/proj/new')
    expect(injected.addProject).toHaveBeenCalledWith('/proj/new')

    await ctx.workspace.removeProject('/proj/mock')
    expect(injected.removeProject).toHaveBeenCalledWith('/proj/mock')

    expect(await ctx.workspace.validateProjectDir('/proj/mock')).toBeNull()
    expect(injected.validateProjectDir).toHaveBeenCalledWith('/proj/mock')
  })

  it('hasProject is derived from the injected provider listProjects (no separate hasProject call required)', async () => {
    const injected = {
      listProjects: vi.fn(() => [
        { name: 'x', path: '/p/x', lastOpened: null } satisfies Project,
      ]),
      addProject: vi.fn(),
      removeProject: vi.fn(),
    }

    const ctx = createWorkbenchContext({
      mainWindow: fakeMainWindow(),
      preloadPath: '/fake/preload.js',
      rendererDir: '/fake/renderer',
      projectsProvider: injected,
    })

    expect(await ctx.workspace.hasProject('/p/x')).toBe(true)
    expect(await ctx.workspace.hasProject('/p/unknown')).toBe(false)
    // listProjects on the provider was consulted (proves no direct repo call).
    expect(injected.listProjects).toHaveBeenCalled()
  })

  it('without an injected provider, workspace-service still works via the default LocalProjectsProvider (regression guard)', async () => {
    const ctx = createWorkbenchContext({
      mainWindow: fakeMainWindow(),
      preloadPath: '/fake/preload.js',
      rendererDir: '/fake/renderer',
    })

    // The default provider reads from the mocked fs (which reports no
    // projects file → []). The contract is: no crash, list is empty array.
    expect(await ctx.workspace.listProjects()).toEqual([])
    expect(await ctx.workspace.hasProject('/anything')).toBe(false)
  })

  it('workspace-service uses ctx.projectsProvider, not the static repo, when constructed via createWorkspaceService directly', async () => {
    // A second path many callers actually use in tests: building a workspace
    // service against a hand-rolled context. The provider on the context must
    // be the only authority — bypassing it would create two sources of truth.
    const injected = {
      listProjects: vi.fn(() => [
        { name: 'only', path: '/only', lastOpened: null } as Project,
      ]),
      addProject: vi.fn(),
      removeProject: vi.fn(),
      validateProjectDir: vi.fn(() => 'nope'),
    }
    const fakeCtx = {
      mainWindow: fakeMainWindow(),
      adapter: { openProject: vi.fn() },
      preloadPath: '/x',
      rendererDir: '/y',
      panels: [],
      apiNamespaces: [],
      appName: 'x',
      workbenchSettingsWindow: null,
      views: {
        disposeAll: vi.fn(),
        getSimulatorWebContentsId: () => null,
        repositionAll: vi.fn(),
      },
      windows: {} as never,
      notify: { projectStatus: vi.fn(), windowNavigateBack: vi.fn() } as never,
      senderPolicy: () => true,
      registry: { add: vi.fn(), dispose: vi.fn() } as never,
      projectsProvider: injected,
    } as unknown as Parameters<typeof createWorkspaceService>[0]

    const ws = createWorkspaceService(fakeCtx)
    await ws.listProjects()
    await ws.validateProjectDir('/x')
    expect(injected.listProjects).toHaveBeenCalled()
    expect(injected.validateProjectDir).toHaveBeenCalledWith('/x')
  })

  it('async ProjectsProvider methods are awaited end-to-end (qdmp remote workspace contract)', async () => {
    // Bug this catches: workspace-service strips Promise return types so a
    // host that returns `Promise<Project[]>` (remote API call) ends up with
    // the renderer receiving a Promise object instead of resolved data.
    const remoteProjects: Project[] = [
      { name: 'remote-a', path: '/r/a', lastOpened: null },
    ]
    const injected = {
      listProjects: vi.fn(async () => remoteProjects),
      addProject: vi.fn(async (p: string) => ({ name: 'r', path: p, lastOpened: null })),
      removeProject: vi.fn(async () => undefined),
      validateProjectDir: vi.fn(async () => null),
    }

    const ctx = createWorkbenchContext({
      mainWindow: fakeMainWindow(),
      preloadPath: '/fake/preload.js',
      rendererDir: '/fake/renderer',
      projectsProvider: injected,
    })

    expect(await ctx.workspace.listProjects()).toEqual(remoteProjects)
    expect(await ctx.workspace.hasProject('/r/a')).toBe(true)
    const added = await ctx.workspace.addProject('/r/b')
    expect(added.path).toBe('/r/b')
    expect(await ctx.workspace.validateProjectDir('/r/a')).toBeNull()
  })
})
