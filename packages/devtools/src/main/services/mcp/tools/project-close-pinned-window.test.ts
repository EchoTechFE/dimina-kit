/**
 * `project_close` takes down the window it was aimed at.
 *
 * Closing a project awaits the session teardown, and the user is free to click
 * another project's window while that runs. The window to close is therefore
 * resolved BEFORE the await: resolving it afterwards closes whatever window
 * happens to be active by then, which leaves the closed project's window on
 * screen with an empty session inside it and takes down a project the user
 * never asked to close.
 */
import { describe, expect, it } from 'vitest'
import { registerProjectTools, type McpProjectHost } from './project-tools.js'

type ToolFn = () => Promise<{ content: Array<{ text: string }> }>

/** Captures the tool callbacks `registerProjectTools` installs. */
function collectTools(host: McpProjectHost): Map<string, ToolFn> {
  const tools = new Map<string, ToolFn>()
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, fn: ToolFn) => {
      tools.set(name, fn)
    },
  }
  registerProjectTools(server as unknown as Parameters<typeof registerProjectTools>[0], host)
  return tools
}

const settled = { phase: 'ready' as const, message: '', watcherAlive: true, updatedAt: 0, generation: 1 }
const sessionStatus = {
  get: () => settled,
  waitForSettled: async () => settled,
  record: () => {},
} as unknown as McpProjectHost['sessionStatus']

/** One project window: its own workspace, and a ledger of what was torn down. */
function makeWindow(projectPath: string, onCloseProject: () => void) {
  return {
    projectPath,
    workspace: {
      validateProjectDir: async () => null,
      hasProject: async () => true,
      addProject: async () => ({ name: projectPath, path: projectPath }),
      listProjects: async () => [],
      closeProject: async () => { onCloseProject() },
      getProjectPath: () => projectPath,
      hasActiveSession: () => true,
    },
    sessionStatus,
  }
}

describe('project_close with a second project window open', () => {
  it('closes the window it started on, not the one the user focused mid-close', async () => {
    const closedSessions: string[] = []
    const closedWindows: string[] = []

    const a = makeWindow('/proj/a', () => {
      closedSessions.push('/proj/a')
      // The user clicks project B's window while the session teardown runs.
      active = b
    })
    const b = makeWindow('/proj/b', () => { closedSessions.push('/proj/b') })
    let active = a

    const host: McpProjectHost = {
      get workspace() { return active.workspace },
      get sessionStatus() { return active.sessionStatus },
      compileLogs: { read: () => ({ lines: [], nextCursor: 0 }) } as unknown as McpProjectHost['compileLogs'],
      requestOpenInUi: async () => { throw new Error('project_close must not open anything') },
      pinActiveProjectWindow: () => {
        const pinned = active
        return () => { closedWindows.push(pinned.projectPath) }
      },
    }

    const close = collectTools(host).get('project_close')!
    await close()

    expect(
      closedSessions,
      'the session that gets closed is the one the tool was aimed at',
    ).toEqual(['/proj/a'])
    expect(
      closedWindows,
      'the window that gets closed must be the one whose session was just torn down — closing the window the user moved to strands an empty window and kills a project they never asked to close',
    ).toEqual(['/proj/a'])
  })

  it('still reports the close when no project window is left to take down', async () => {
    const host: McpProjectHost = {
      workspace: makeWindow('/proj/only', () => {}).workspace,
      sessionStatus,
      compileLogs: { read: () => ({ lines: [], nextCursor: 0 }) } as unknown as McpProjectHost['compileLogs'],
      requestOpenInUi: async () => { throw new Error('project_close must not open anything') },
      pinActiveProjectWindow: () => null,
    }

    const close = collectTools(host).get('project_close')!
    const result = await close()

    expect(
      JSON.parse(result.content[0]!.text),
      'a session with no window behind it is still closed; the tool must not fail on the missing window',
    ).toEqual({ closed: true })
  })
})
