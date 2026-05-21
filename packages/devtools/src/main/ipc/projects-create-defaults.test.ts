/**
 * Suggestion-mode follow-up: the create-project dialog pre-fills its
 * target path from `<defaults.baseDir>/<slug(name)>`. The IPC contract is:
 *
 *  - `projects:getCreateDefaults` returns a `baseDir` that prefers
 *    `WorkbenchSettings.lastCreateBaseDir` if persisted, else a platform
 *    default (Electron's `app.getPath('documents')`).
 *  - `projects:create` writes `path.dirname(input.path)` back into
 *    `WorkbenchSettings.lastCreateBaseDir` after a successful create, so
 *    the next open of the dialog suggests the same workspace.
 *  - A failing `createProject` MUST NOT mutate `lastCreateBaseDir` — only
 *    a successful scaffold should bump the suggestion.
 *
 * Bugs each test catches:
 *  - Defaults handler regression that always returns `null`/empty would
 *    leave the renderer suggesting just the slug (the user reported this
 *    feels broken on first launch).
 *  - Forgetting to update settings after create means the user has to
 *    re-pick the same parent dir every time — the original symptom that
 *    motivated this work.
 *  - Updating settings even on failed creates would push the user toward
 *    a workspace where the scaffold actually didn't happen.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  const handlers = new Map<string, AnyFn>()
  function reset() {
    handlers.clear()
  }
  return { handlers, reset }
})

vi.mock('electron', () => {
  type AnyFn = (...args: unknown[]) => unknown
  const ipcMain = {
    handle: vi.fn((channel: string, fn: AnyFn) => {
      stubs.handlers.set(channel, fn)
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
  const app = {
    getPath: vi.fn((name: string) =>
      name === 'documents' ? '/Users/test/Documents' : '/Users/test',
    ),
  }
  return { ipcMain, dialog, app, default: { ipcMain, dialog, app } }
})

// Capture settings load/save side effects.
const settingsState = vi.hoisted(() => ({
  current: {
    cdp: { enabled: false, port: 9222 },
    mcp: { enabled: false, port: 7789 },
    compile: { watch: true },
    theme: 'system' as const,
    lastCreateBaseDir: null as string | null,
  },
}))

vi.mock('../services/settings/index.js', () => ({
  loadWorkbenchSettings: vi.fn(() => settingsState.current),
  saveWorkbenchSettings: vi.fn((next: typeof settingsState.current) => {
    settingsState.current = next
  }),
  applyTheme: vi.fn(),
}))

// Stub create-project-service so we can drive success/failure.
const createProjectSpy = vi.hoisted(() => vi.fn())
vi.mock('../services/projects/create-project-service.js', () => ({
  createProject: createProjectSpy,
}))

import { ProjectsChannel } from '../../shared/ipc-channels.js'
let registerProjectsIpc: typeof import('./projects.js').registerProjectsIpc

beforeEach(async () => {
  stubs.reset()
  createProjectSpy.mockReset()
  settingsState.current = {
    cdp: { enabled: false, port: 9222 },
    mcp: { enabled: false, port: 7789 },
    compile: { watch: true },
    theme: 'system',
    lastCreateBaseDir: null,
  }
  vi.resetModules()
  ;({ registerProjectsIpc } = await import('./projects.js'))
})

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = stubs.handlers.get(channel)
  if (!fn) throw new Error(`no handler registered for '${channel}'`)
  const fakeEvent = {
    sender: { id: 1, isDestroyed: () => false, getURL: () => '' },
  }
  return await (fn as (e: unknown, ...a: unknown[]) => unknown)(fakeEvent, ...args)
}

function makeCtx() {
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
    projectsProvider: {
      listProjects: vi.fn(() => []),
      addProject: vi.fn((p: string) => ({ name: 'x', path: p, lastOpened: null })),
      removeProject: vi.fn(),
    } as import('../services/projects/types.js').ProjectsProvider,
    projectTemplates: [],
    customCreateProjectDialog: undefined,
  } as unknown as Parameters<typeof registerProjectsIpc>[0]
}

describe('ProjectsChannel.GetCreateDefaults', () => {
  it('falls back to app.getPath("documents") on first run (no persisted base)', async () => {
    registerProjectsIpc(makeCtx())
    const out = await invoke(ProjectsChannel.GetCreateDefaults)
    expect(out).toEqual({ baseDir: '/Users/test/Documents' })
  })

  it('returns the persisted base when settings.lastCreateBaseDir is set', async () => {
    settingsState.current.lastCreateBaseDir = '/Users/test/code/work'
    registerProjectsIpc(makeCtx())
    const out = await invoke(ProjectsChannel.GetCreateDefaults)
    expect(out).toEqual({ baseDir: '/Users/test/code/work' })
  })
})

describe('ProjectsChannel.Create — lastCreateBaseDir persistence', () => {
  it('updates lastCreateBaseDir to path.dirname(input.path) on success', async () => {
    createProjectSpy.mockResolvedValue({
      name: 'X',
      path: '/Users/test/code/x',
      lastOpened: null,
    })
    registerProjectsIpc(makeCtx())

    await invoke(ProjectsChannel.Create, {
      name: 'X',
      path: '/Users/test/code/x',
      templateId: 'blank',
    })
    expect(settingsState.current.lastCreateBaseDir).toBe('/Users/test/code')

    // Next GetCreateDefaults reflects the new base.
    const out = await invoke(ProjectsChannel.GetCreateDefaults)
    expect(out).toEqual({ baseDir: '/Users/test/code' })
  })

  it('does NOT update lastCreateBaseDir when create-project-service rejects', async () => {
    settingsState.current.lastCreateBaseDir = '/Users/test/Documents'
    createProjectSpy.mockRejectedValue(new Error('path is not empty'))
    registerProjectsIpc(makeCtx())

    await expect(
      invoke(ProjectsChannel.Create, {
        name: 'X',
        path: '/Users/test/somewhere/else/x',
        templateId: 'blank',
      }),
    ).rejects.toThrow()
    expect(settingsState.current.lastCreateBaseDir).toBe('/Users/test/Documents')
  })
})
