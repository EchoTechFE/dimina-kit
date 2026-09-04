/**
 * Resolving the window an MCP-driven `project_open` landed in.
 *
 * Each project window keeps its own session-status store, so an open has to
 * hand back the store of the window it actually opened together with the
 * generation guard for awaiting THAT window's compile:
 *  - a window built by this open starts empty, so its initial 'idle' must not
 *    be mistaken for a finished compile;
 *  - a window that was already showing the project is only focused, which
 *    triggers no compile, so its current settled state is the answer.
 */
import { describe, expect, it } from 'vitest'
import { createSessionStatusStore } from '../workspace/session-status-store.js'
import { createOpenForMcp } from './opened-project.js'

interface FakeWindow {
  window: { id: string }
  context: {
    workspace: { getProjectPath: () => string; hasActiveSession: () => boolean }
    sessionStatus: ReturnType<typeof createSessionStatusStore>
  }
}

function makeWindow(projectPath: string): FakeWindow {
  return {
    window: { id: projectPath },
    context: {
      workspace: { getProjectPath: () => projectPath, hasActiveSession: () => true },
      sessionStatus: createSessionStatusStore(),
    },
  }
}

/** A window manager that builds a window on first open and focuses it after. */
function makeManager(initial: FakeWindow[] = []) {
  const windows = [...initial]
  const open = createOpenForMcp<FakeWindow['window']>({
    open: async (project) => {
      const existing = windows.find((w) => w.window.id === project.path)
      if (existing) return existing.window
      const created = makeWindow(project.path)
      windows.push(created)
      return created.window
    },
    list: () => windows,
  })
  return { open, windows }
}

describe('createOpenForMcp', () => {
  it('hands back the store of the window it opened, not another project window', async () => {
    const other = makeWindow('/proj/other')
    other.context.sessionStatus.record({ status: 'ready', message: 'another project' })
    const { open, windows } = makeManager([other])

    const opened = await open({ name: 'demo', path: '/proj/demo' })

    const demo = windows.find((w) => w.window.id === '/proj/demo')!
    expect(
      opened.sessionStatus,
      'project_open must await the compile of the window it opened',
    ).toBe(demo.context.sessionStatus)
    expect(
      opened.workspace.getProjectPath(),
      'the reported status must describe the project that was opened',
    ).toBe('/proj/demo')
  })

  it('guards a freshly built window so its empty store never counts as settled', async () => {
    const { open, windows } = makeManager()

    const opened = await open({ name: 'demo', path: '/proj/demo' })
    const demo = windows[0]!

    let settled = false
    void opened.sessionStatus
      .waitForSettled({ afterGeneration: opened.afterGeneration, timeoutMs: 1000 })
      .then(() => { settled = true })
    await new Promise((r) => setTimeout(r, 0))
    expect(
      settled,
      'a brand-new window has recorded nothing yet, so project_open must keep waiting',
    ).toBe(false)

    demo.context.sessionStatus.record({ status: 'ready', message: '编译完成' })
    await new Promise((r) => setTimeout(r, 0))
    expect(settled, 'the first state this window records is the open result').toBe(true)
  })

  it('accepts the settled state of a project that was already open', async () => {
    const demo = makeWindow('/proj/demo')
    demo.context.sessionStatus.record({ status: 'ready', message: '编译完成' })
    const { open } = makeManager([demo])

    const opened = await open({ name: 'demo', path: '/proj/demo' })
    const settled = await opened.sessionStatus.waitForSettled({
      afterGeneration: opened.afterGeneration,
      timeoutMs: 50,
    })

    expect(
      settled.message,
      'focusing an already-open project starts no compile, so its current state is the answer',
    ).toBe('编译完成')
  })

  it('fails loudly when the window it opened is already gone', async () => {
    const open = createOpenForMcp<{ id: string }>({
      open: async () => ({ id: 'vanished' }),
      list: () => [],
    })

    await expect(open({ name: 'demo', path: '/proj/demo' })).rejects.toThrow(/\/proj\/demo/)
  })
})
