/**
 * Host contract project-tools is expected to drive after the pinned-target
 * refactor: each tool call takes one `currentProject()` snapshot at the door
 * and works against it for its whole lifetime, instead of re-reading live
 * `workspace` / `sessionStatus` / `compileLogs` getters (or a separately
 * re-resolved `pinActiveProjectWindow`) that can point at a different project
 * window by the time an awaited step resolves.
 */
import { describe, expect, it, vi } from 'vitest'
import { createCompileLogBuffer } from '../../workspace/compile-log-buffer.js'
import { createSessionStatusStore } from '../../workspace/session-status-store.js'
import { registerProjectTools, type McpProjectHost } from './project-tools.js'

interface ToolResult {
  content: { type: string; text: string }[]
  isError?: boolean
}
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>

/** The per-call target `currentProject()` is expected to hand back. */
interface FakeTarget {
  workspace: {
    validateProjectDir: (dir: string) => Promise<string | null>
    hasProject: (dir: string) => Promise<boolean>
    addProject: (dir: string) => Promise<{ name: string; path: string }>
    listProjects: () => Promise<{ name: string; path: string }[]>
    closeProject: () => Promise<void>
    getProjectPath: () => string
    hasActiveSession: () => boolean
  }
  sessionStatus: ReturnType<typeof createSessionStatusStore>
  compileLogs: ReturnType<typeof createCompileLogBuffer>
  closeWindow: ReturnType<typeof vi.fn>
}

function makeTarget(projectPath: string): FakeTarget {
  return {
    workspace: {
      validateProjectDir: vi.fn(async () => null),
      hasProject: vi.fn(async () => true),
      addProject: vi.fn(async (dir: string) => ({ name: dir, path: dir })),
      listProjects: vi.fn(async () => []),
      closeProject: vi.fn(async () => {}),
      getProjectPath: vi.fn(() => projectPath),
      hasActiveSession: vi.fn(() => true),
    },
    sessionStatus: createSessionStatusStore(),
    compileLogs: createCompileLogBuffer(),
    closeWindow: vi.fn(),
  }
}

/** A host whose `currentProject()` answer can be swapped mid-call, like a user re-focusing a window. */
function makeHost(initial: FakeTarget) {
  let current = initial
  const currentProject = vi.fn(() => current)
  const host = {
    currentProject,
    requestOpenInUi: vi.fn(async () => { throw new Error('not exercised by these tools') }),
  } as unknown as McpProjectHost
  return { host, currentProject, setCurrent: (t: FakeTarget) => { current = t } }
}

function captureTools(host: McpProjectHost) {
  const handlers = new Map<string, ToolHandler>()
  const server = {
    tool(name: string, _desc: string, _schema: unknown, handler: ToolHandler) {
      handlers.set(name, handler)
    },
  } as unknown as Parameters<typeof registerProjectTools>[0]
  registerProjectTools(server, host)
  function call(name: string, args: Record<string, unknown> = {}) {
    const handler = handlers.get(name)
    if (!handler) throw new Error(`tool not registered: ${name}`)
    return handler(args)
  }
  return { call }
}

function parse(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>
}

describe('project_wait_ready pins its target for the whole wait', () => {
  it('reports the project held at call time, not whichever project is current when the wait settles', async () => {
    const a = makeTarget('/proj/a')
    const b = makeTarget('/proj/b')
    b.sessionStatus.record({ status: 'compiling', message: '' })
    const { host, setCurrent } = makeHost(b)
    const { call } = captureTools(host)

    const pending = call('project_wait_ready', { timeoutMs: 1000 })
    await new Promise((r) => setTimeout(r, 0))
    // The user switches the focused project window while B's compile is still running.
    setCurrent(a)
    b.sessionStatus.record({ status: 'ready', message: '编译完成' })

    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(
      parse(result),
      'the settled state must come from the target this call pinned (B), not the window current when it resolved',
    ).toMatchObject({ projectPath: '/proj/b' })
  })
})

describe('project_close pins its target before awaiting the teardown', () => {
  it('closes the window pinned at call time, not the one focused when closeProject() resolves', async () => {
    const a = makeTarget('/proj/a')
    const b = makeTarget('/proj/b')
    let resolveClose: () => void = () => {}
    vi.mocked(b.workspace.closeProject).mockImplementation(
      () => new Promise<void>((resolve) => { resolveClose = resolve }),
    )
    const { host, setCurrent } = makeHost(b)
    const { call } = captureTools(host)

    const pending = call('project_close')
    await new Promise((r) => setTimeout(r, 0))
    setCurrent(a)
    resolveClose()
    await pending

    expect(b.closeWindow, 'the window whose session was just torn down must be the one that closes').toHaveBeenCalledTimes(1)
    expect(a.closeWindow, 'the window the user moved to mid-close must be left alone').not.toHaveBeenCalled()
  })
})

describe('project_status reads currentProject() exactly once per call', () => {
  it('does not re-resolve the target after the initial snapshot', async () => {
    const a = makeTarget('/proj/a')
    a.sessionStatus.record({ status: 'ready', message: '编译完成' })
    const { host, currentProject } = makeHost(a)
    const { call } = captureTools(host)

    const result = await call('project_status')
    expect(parse(result)).toMatchObject({ projectPath: '/proj/a' })
    expect(
      currentProject,
      'a call that re-resolves the target on every property access would call this more than once',
    ).toHaveBeenCalledTimes(1)
  })
})
