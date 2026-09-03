/**
 * Contract: `projects:openEditDialog` (registerProjectsIpc's
 * ProjectsChannel.OpenEditDialog handler).
 *
 * Bugs each test catches:
 *  - No `customEditProjectDialog` hook configured must return a bare `null`
 *    (not `{ result: null }`) — that's the renderer's only signal to fall
 *    back to the built-in dialog.
 *  - A configured hook that resolves `null` (user cancelled) must come back
 *    wrapped as `{ result: null }`. Collapsing it to a bare `null` would make
 *    the renderer indistinguishable from "no hook configured" and pop the
 *    built-in dialog right behind the cancelled host one.
 *  - A hook's patch / `{ updated }` result must cross the wire unmodified,
 *    wrapped in `{ result }`.
 *  - The `project` handed to the hook must come from the workspace's own
 *    authoritative record (`listProjects()`), never a client-trusted object
 *    reconstructed from the IPC args — otherwise a host hook renders whatever
 *    stale/forged fields the renderer happened to send.
 *  - An unknown path must reject before the hook ever runs, so a host hook
 *    never has to defend against a dangling project record.
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
    showOpenDialog: vi.fn(() => Promise.resolve({ canceled: true, filePaths: [] })),
    showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
  }
  return { ipcMain, dialog, default: { ipcMain, dialog } }
})

import { ProjectsChannel } from '../../shared/ipc-channels.js'
let registerProjectsIpc: typeof import('./projects.js').registerProjectsIpc

beforeEach(async () => {
  stubs.reset()
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

type Hook = NonNullable<
  import('../../shared/types.js').WorkbenchAppConfig['customEditProjectDialog']
>

function makeCtx(opts: {
  listProjects?: import('../../shared/types.js').EditableProject[]
  customEditProjectDialog?: Hook
} = {}) {
  const mainWindow = { id: 99 } as unknown as import('electron').BrowserWindow
  return {
    workspace: {
      listProjects: vi.fn(() => opts.listProjects ?? []),
    },
    windows: { mainWindow },
    senderPolicy: () => true,
    projectsProvider: undefined,
    projectTemplates: [],
    customCreateProjectDialog: undefined,
    customEditProjectDialog: opts.customEditProjectDialog,
  } as unknown as import('./projects.js').ProjectsIpcCtx
}

describe('ProjectsChannel.OpenEditDialog', () => {
  it('returns a bare null when no customEditProjectDialog hook is configured (renderer falls back to built-in dialog)', async () => {
    const ctx = makeCtx({ listProjects: [{ name: 'Alpha', path: '/abs/alpha' }] })
    registerProjectsIpc(ctx)

    const out = await invoke(ProjectsChannel.OpenEditDialog, '/abs/alpha')
    expect(out).toBeNull()
  })

  it('wraps a cancelled hook result as { result: null }, not a bare null', async () => {
    const hook: Hook = vi.fn(async () => null)
    const ctx = makeCtx({
      listProjects: [{ name: 'Alpha', path: '/abs/alpha' }],
      customEditProjectDialog: hook,
    })
    registerProjectsIpc(ctx)

    const out = await invoke(ProjectsChannel.OpenEditDialog, '/abs/alpha')
    expect(out).toEqual({ result: null })
  })

  it('wraps a hook patch result as { result: patch }', async () => {
    const hook: Hook = vi.fn(async () => ({ name: 'Renamed' }))
    const ctx = makeCtx({
      listProjects: [{ name: 'Alpha', path: '/abs/alpha' }],
      customEditProjectDialog: hook,
    })
    registerProjectsIpc(ctx)

    const out = await invoke(ProjectsChannel.OpenEditDialog, '/abs/alpha')
    expect(out).toEqual({ result: { name: 'Renamed' } })
  })

  it('wraps a hook { updated } result as { result: { updated } }', async () => {
    const updated = { name: 'Alpha', path: '/abs/alpha', iconUrl: 'https://cdn.example.com/a.png' }
    const hook: Hook = vi.fn(async () => ({ updated }))
    const ctx = makeCtx({
      listProjects: [{ name: 'Alpha', path: '/abs/alpha' }],
      customEditProjectDialog: hook,
    })
    registerProjectsIpc(ctx)

    const out = await invoke(ProjectsChannel.OpenEditDialog, '/abs/alpha')
    expect(out).toEqual({ result: { updated } })
  })

  it("passes the workspace's own list record (not a client-reconstructed object) and the main window as parentWindow", async () => {
    const hook: Hook = vi.fn(async () => null)
    const listRecord = {
      name: 'Alpha',
      path: '/abs/alpha',
      // Only present on the authoritative list record — proves the handler
      // read from workspace.listProjects(), not from the IPC args.
      iconUrl: 'https://cdn.example.com/a.png',
    }
    const ctx = makeCtx({ listProjects: [listRecord], customEditProjectDialog: hook })
    registerProjectsIpc(ctx)

    await invoke(ProjectsChannel.OpenEditDialog, '/abs/alpha')

    expect(hook).toHaveBeenCalledTimes(1)
    const arg = (hook as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      parentWindow: unknown
      project: unknown
    }
    expect(arg.project).toEqual(listRecord)
    expect(arg.parentWindow).toBe(ctx.windows.mainWindow)
  })

  it('rejects on an unknown path and never calls the hook', async () => {
    const hook: Hook = vi.fn(async () => null)
    const ctx = makeCtx({
      listProjects: [{ name: 'Alpha', path: '/abs/alpha' }],
      customEditProjectDialog: hook,
    })
    registerProjectsIpc(ctx)

    await expect(
      invoke(ProjectsChannel.OpenEditDialog, '/abs/missing'),
    ).rejects.toThrow(/No such project/)
    expect(hook).not.toHaveBeenCalled()
  })
})
