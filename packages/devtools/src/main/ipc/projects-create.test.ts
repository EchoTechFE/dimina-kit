/**
 * Phase 3 contract: the projects-IPC module exposes three new channels:
 *  - projects:listTemplates    → sanitized merged catalog (no `generate` fns)
 *  - projects:openCreateDialog → host hook OR null
 *  - projects:create           → delegates to create-project-service
 *
 * Bugs each test catches:
 *  - `listTemplates` leaking a `generate` function would cause structured-
 *    clone errors on IPC, crashing the renderer dialog at module load.
 *  - `openCreateDialog` returning a non-null fallback when no hook is set
 *    would short-circuit the built-in dialog the renderer needs to show.
 *  - `openCreateDialog` not forwarding the merged + sanitized templates to
 *    the host hook means the host can't render the same template list the
 *    built-in dialog would.
 *  - `create` not delegating to create-project-service (e.g. calling
 *    provider.addProject directly with no scaffold) would leave the new
 *    project's directory empty.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Hoisted stubs (the same shape used by other IPC tests in this dir) ──
const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  const handlers = new Map<string, AnyFn>()
  const handleCalls: string[] = []

  function reset() {
    handlers.clear()
    handleCalls.length = 0
  }

  return { handlers, handleCalls, reset }
})

vi.mock('electron', () => {
  type AnyFn = (...args: unknown[]) => unknown
  const ipcMain = {
    handle: vi.fn((channel: string, fn: AnyFn) => {
      stubs.handlers.set(channel, fn)
      stubs.handleCalls.push(channel)
    }),
    removeHandler: vi.fn((channel: string) => {
      stubs.handlers.delete(channel)
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  }
  const dialog = {
    showOpenDialog: vi.fn(() =>
      Promise.resolve({ canceled: true, filePaths: [] }),
    ),
    showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
  }
  return { ipcMain, dialog, default: { ipcMain, dialog } }
})

// Mock create-project-service so we can observe the IPC handler delegating.
const createProjectSpy = vi.hoisted(() => vi.fn())
vi.mock('../services/projects/create-project-service.js', () => ({
  createProject: createProjectSpy,
}))

// ── Lazy imports ────────────────────────────────────────────────────────
import { ProjectsChannel } from '../../shared/ipc-channels.js'
let registerProjectsIpc: typeof import('./projects.js').registerProjectsIpc

beforeEach(async () => {
  stubs.reset()
  createProjectSpy.mockReset()
  vi.resetModules()
  ;({ registerProjectsIpc } = await import('./projects.js'))
})

/** Invoke a registered ipcMain.handle handler with a fake trusted sender. */
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = stubs.handlers.get(channel)
  if (!fn) throw new Error(`no handler registered for '${channel}'`)
  const fakeEvent = {
    sender: { id: 1, isDestroyed: () => false, getURL: () => '' },
  }
  return await (fn as (e: unknown, ...a: unknown[]) => unknown)(fakeEvent, ...args)
}

function makeCtx(opts: {
  templates?: import('../services/projects/types.js').ProjectTemplate[]
  customCreateProjectDialog?: import('../../shared/types.js').WorkbenchAppConfig['customCreateProjectDialog']
  projectsProvider?: import('../services/projects/types.js').ProjectsProvider
} = {}) {
  const provider =
    opts.projectsProvider ??
    ({
      listProjects: vi.fn(() => []),
      addProject: vi.fn((p: string) => ({ name: 'x', path: p, lastOpened: null })),
      removeProject: vi.fn(),
      validateProjectDir: vi.fn(() => null),
    } as import('../services/projects/types.js').ProjectsProvider)

  return {
    workspace: {
      listProjects: () => [],
      addProject: vi.fn(),
      removeProject: vi.fn(),
      hasProject: vi.fn(() => false),
      validateProjectDir: vi.fn(() => null),
    },
    windows: {
      mainWindow: { id: 99 } as unknown as import('electron').BrowserWindow,
    },
    senderPolicy: () => true,
    projectsProvider: provider,
    projectTemplates: opts.templates ?? [],
    customCreateProjectDialog: opts.customCreateProjectDialog,
  } as unknown as Parameters<typeof registerProjectsIpc>[0]
}

describe('ProjectsChannel.ListTemplates', () => {
  it('returns the merged catalog with `generate` functions stripped (structured-clone-safe)', async () => {
    const templates = [
      { id: 'codegen', name: 'CodeGen', generate: async () => {} },
      { id: 'blank', name: 'Blank' },
    ] as import('../services/projects/types.js').ProjectTemplate[]
    const ctx = makeCtx({ templates })
    registerProjectsIpc(ctx)

    const out = (await invoke(ProjectsChannel.ListTemplates)) as Array<{
      id: string
      generate?: unknown
    }>
    expect(out.find((t) => t.id === 'codegen')).toBeDefined()
    expect(out.find((t) => t.id === 'codegen')!.generate).toBeUndefined()
    expect(out.find((t) => t.id === 'blank')).toBeDefined()
  })
})

describe('ProjectsChannel.OpenCreateDialog', () => {
  it("returns null when no customCreateProjectDialog hook is configured (renderer falls back to built-in dialog)", async () => {
    const ctx = makeCtx({ templates: [{ id: 'blank', name: 'Blank' }] })
    registerProjectsIpc(ctx)

    const out = await invoke(ProjectsChannel.OpenCreateDialog)
    expect(out).toBeNull()
  })

  it('invokes the host hook with the merged + sanitized templates and propagates the returned input', async () => {
    type Hook = NonNullable<
      import('../../shared/types.js').WorkbenchAppConfig['customCreateProjectDialog']
    >
    const hook: Hook = vi.fn(
      async (_ctx: Parameters<Hook>[0]) =>
        ({
          name: 'My App',
          path: '/abs/target',
          templateId: 'blank',
        } as Awaited<ReturnType<Hook>>),
    )
    const ctx = makeCtx({
      templates: [
        { id: 'codegen', name: 'CodeGen', generate: async () => {} },
        { id: 'blank', name: 'Blank' },
      ] as import('../services/projects/types.js').ProjectTemplate[],
      customCreateProjectDialog: hook,
    })
    registerProjectsIpc(ctx)

    const out = await invoke(ProjectsChannel.OpenCreateDialog)
    expect(hook).toHaveBeenCalledTimes(1)
    const arg = (hook as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![0] as {
      parentWindow: unknown
      templates: Array<{ id: string; generate?: unknown }>
    }
    expect(arg.templates.find((t) => t.id === 'codegen')!.generate).toBeUndefined()
    expect(out).toEqual({
      name: 'My App',
      path: '/abs/target',
      templateId: 'blank',
    })
  })

  it('returns null when the host hook returns null (user cancelled)', async () => {
    type Hook = NonNullable<
      import('../../shared/types.js').WorkbenchAppConfig['customCreateProjectDialog']
    >
    const hook: Hook = vi.fn(
      async (_ctx: Parameters<Hook>[0]) =>
        null as Awaited<ReturnType<Hook>>,
    )
    const ctx = makeCtx({
      templates: [{ id: 'blank', name: 'Blank' }],
      customCreateProjectDialog: hook,
    })
    registerProjectsIpc(ctx)

    const out = await invoke(ProjectsChannel.OpenCreateDialog)
    expect(out).toBeNull()
  })
})

describe('ProjectsChannel.Create', () => {
  it('delegates to create-project-service with the renderer-supplied input and the ctx templates+provider', async () => {
    const fakeProject = { name: 'X', path: '/abs/target', lastOpened: null }
    createProjectSpy.mockResolvedValue(fakeProject)

    const provider = {
      listProjects: vi.fn(() => []),
      addProject: vi.fn((p: string) => ({ name: 'x', path: p, lastOpened: null })),
      removeProject: vi.fn(),
    } as unknown as import('../services/projects/types.js').ProjectsProvider
    const templates = [
      { id: 'blank', name: 'Blank' },
    ] as import('../services/projects/types.js').ProjectTemplate[]
    const ctx = makeCtx({ templates, projectsProvider: provider })
    registerProjectsIpc(ctx)

    const input = {
      name: 'X',
      path: '/abs/target',
      templateId: 'blank',
    }
    const out = await invoke(ProjectsChannel.Create, input)
    expect(out).toEqual(fakeProject)
    expect(createProjectSpy).toHaveBeenCalledTimes(1)
    const [actualInput, actualCtx] = createProjectSpy.mock.calls[0]!
    expect(actualInput).toEqual(input)
    expect(actualCtx.projectsProvider).toBe(provider)
    // The IPC handler should pass the merged template catalog (sanitized
    // or not is OK here — create-project-service runs in main and can
    // accept generate functions). The crucial assertion is `templates`
    // is forwarded at all.
    expect(Array.isArray(actualCtx.templates)).toBe(true)
    expect(actualCtx.templates.find((t: { id: string }) => t.id === 'blank')).toBeDefined()
  })

  it('surfaces a create-project-service rejection back to the renderer (e.g. "path not empty")', async () => {
    createProjectSpy.mockRejectedValue(new Error('Project path is not empty'))

    const ctx = makeCtx({ templates: [{ id: 'blank', name: 'Blank' }] })
    registerProjectsIpc(ctx)

    await expect(
      invoke(ProjectsChannel.Create, {
        name: 'X',
        path: '/abs/target',
        templateId: 'blank',
      }),
    ).rejects.toThrow(/not empty/)
  })

  it('shows a native error dialog before rejecting on create-service failure (visible-error UX)', async () => {
    // Bug caught: regression to swallow scaffold failures into a silent
    // console.warn leaves the user staring at an unchanged screen with
    // no idea why the new-project click did nothing.
    createProjectSpy.mockRejectedValue(new Error('Template source missing on disk: /tpl/x'))
    const electron = await import('electron')
    const showMessageBox = vi.mocked(electron.dialog.showMessageBox)
    showMessageBox.mockClear()

    const ctx = makeCtx({ templates: [{ id: 'x', name: 'X' }] })
    registerProjectsIpc(ctx)

    await expect(
      invoke(ProjectsChannel.Create, {
        name: 'X',
        path: '/abs/target',
        templateId: 'x',
      }),
    ).rejects.toThrow(/Template source missing/)

    expect(showMessageBox).toHaveBeenCalledTimes(1)
    // showMessageBox has overloads — (options) and (window, options); the
    // dispatcher picks the last arg either way.
    const call = showMessageBox.mock.calls[0]! as unknown[]
    const opts = call[call.length - 1] as { type: string; detail: string }
    expect(opts.type).toBe('error')
    expect(opts.detail).toMatch(/Template source missing/)
  })
})

describe('ProjectsChannel.OpenCreateDialog — ready bypass', () => {
  it('passes a host hook { ready: Project } result through unchanged so the renderer can skip the scaffold', async () => {
    // Bug caught: an IPC handler that always coerces hook returns into
    // CreateProjectInput shape (e.g. by spreading expected fields) would
    // strip the `ready` discriminator and silently route remote-created
    // projects through the local scaffold path — which would then fail
    // on fs.existsSync of a remote URL or duplicate-register the project.
    type Hook = NonNullable<
      import('../../shared/types.js').WorkbenchAppConfig['customCreateProjectDialog']
    >
    const readyResult = {
      ready: { name: 'Remote App', path: '/remote/ws/abc', lastOpened: null },
    }
    const hook: Hook = vi.fn(
      async () => readyResult as Awaited<ReturnType<Hook>>,
    )
    const ctx = makeCtx({
      templates: [{ id: 'blank', name: 'Blank' }],
      customCreateProjectDialog: hook,
    })
    registerProjectsIpc(ctx)

    const out = await invoke(ProjectsChannel.OpenCreateDialog)
    expect(out).toEqual(readyResult)
    expect(hook).toHaveBeenCalledTimes(1)
  })
})
