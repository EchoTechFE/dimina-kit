/**
 * MCP project lifecycle tools — the compile loop exposed to MCP clients.
 *
 * Contracts pinned here:
 *  - project_open pushes the renderer-driven open (`requestOpenInUi`), never
 *    opens the workspace session from main, and awaits the compile of the
 *    WINDOW that open landed in — not whichever window happened to be active
 *    when the call arrived
 *  - a freshly opened window has recorded nothing yet, so its empty store is
 *    never mistaken for a finished compile
 *  - a compile error surfaces as isError with a compile_logs/stderr pointer
 *  - an already-open ready project short-circuits without re-triggering
 *  - project_status derives the public phase: settled 'ready' with no live
 *    session reports 'idle'; 'error'/'compiling' pass through as-is
 *  - project_wait_ready times out with isError naming the last phase
 *  - compile_logs is a cursor read over the buffer (stream filter included)
 */
import { describe, it, expect, vi } from 'vitest'
import { createCompileLogBuffer } from '../../workspace/compile-log-buffer.js'
import { createSessionStatusStore } from '../../workspace/session-status-store.js'
import type { McpOpenedProject } from '../opened-project.js'
import {
  registerProjectTools,
  type McpProjectHost,
} from './project-tools.js'

interface ToolResult {
  content: { type: string; text: string }[]
  isError?: boolean
}
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>

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
  return { handlers, call }
}

function parse(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>
}

/**
 * The window an open lands in: its own status store plus the generation guard
 * a brand-new window carries (nothing recorded yet, so accept only what this
 * open produces).
 */
function newWindow(): McpOpenedProject {
  return {
    workspace: {
      getProjectPath: vi.fn(() => ''),
      hasActiveSession: vi.fn(() => false),
    },
    sessionStatus: createSessionStatusStore(),
    afterGeneration: 0,
  }
}

function makeHost(
  overrides?: Partial<McpProjectHost['workspace']>,
  opened: McpOpenedProject = newWindow(),
): McpProjectHost {
  return {
    workspace: {
      validateProjectDir: vi.fn(async () => null),
      hasProject: vi.fn(async () => false),
      addProject: vi.fn(async (dir: string) => ({ name: 'demo', path: dir })),
      listProjects: vi.fn(async () => []),
      closeProject: vi.fn(async () => {}),
      getProjectPath: vi.fn(() => ''),
      hasActiveSession: vi.fn(() => false),
      ...overrides,
    },
    sessionStatus: createSessionStatusStore(),
    compileLogs: createCompileLogBuffer(),
    requestOpenInUi: vi.fn(async () => opened),
    pinActiveProjectWindow: vi.fn(() => vi.fn()),
  }
}

describe('project_open', () => {
  it('registers unknown dirs, pushes the renderer open, and resolves on the compile settling', async () => {
    const opened = newWindow()
    const host = makeHost(undefined, opened)
    // Simulate the renderer-driven open: the push eventually produces the
    // compile transitions through the notifier tap (recorded to the store of
    // the window that was opened).
    vi.mocked(host.requestOpenInUi).mockImplementation(async () => {
      opened.sessionStatus.record({ status: 'compiling', message: '编译中' })
      opened.sessionStatus.record({ status: 'ready', message: '编译完成' })
      vi.mocked(opened.workspace.getProjectPath).mockReturnValue('/proj/demo')
      vi.mocked(opened.workspace.hasActiveSession).mockReturnValue(true)
      return opened
    })
    const { call } = captureTools(host)

    const result = await call('project_open', { path: '/proj/demo', timeoutMs: 1000 })

    expect(host.workspace.addProject).toHaveBeenCalledWith('/proj/demo')
    expect(host.requestOpenInUi).toHaveBeenCalledWith({ name: 'demo', path: '/proj/demo' })
    expect(result.isError).toBeUndefined()
    expect(parse(result)).toMatchObject({
      phase: 'ready',
      projectPath: '/proj/demo',
      sessionActive: true,
    })
  })

  it('awaits the window it opened, not the window that was active when the call arrived', async () => {
    const opened = newWindow()
    const host = makeHost(undefined, opened)
    const { call } = captureTools(host)

    const pending = call('project_open', { path: '/proj/demo', timeoutMs: 1000 })
    let done = false
    void pending.then(() => { done = true })

    // The previously active window finishes a rebuild of ITS OWN project,
    // after this open already reached its wait.
    await new Promise((r) => setTimeout(r, 0))
    host.sessionStatus.record({ status: 'compiling', message: '' })
    host.sessionStatus.record({ status: 'ready', message: 'another project rebuilt' })
    await new Promise((r) => setTimeout(r, 0))
    expect(
      done,
      'another project window settling must never be reported as this open result',
    ).toBe(false)

    vi.mocked(opened.workspace.getProjectPath).mockReturnValue('/proj/demo')
    vi.mocked(opened.workspace.hasActiveSession).mockReturnValue(true)
    opened.sessionStatus.record({ status: 'ready', message: '编译完成' })

    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(
      parse(result),
      'the reported status describes the project that was opened',
    ).toMatchObject({ projectPath: '/proj/demo', message: '编译完成' })
  })

  it('never accepts the empty store of a brand-new window as its own result', async () => {
    const opened = newWindow()
    const host = makeHost(undefined, opened)
    const { call } = captureTools(host)

    const pending = call('project_open', { path: '/proj/demo', timeoutMs: 1000 })
    let done = false
    void pending.then(() => { done = true })
    // Macrotask flush: lets the handler run through its awaits and reach the
    // settled-wait. Without the generation guard the fresh window's initial
    // 'idle' would already have resolved it.
    await new Promise((r) => setTimeout(r, 0))
    expect(done, 'a window that has compiled nothing yet must not report success').toBe(false)

    opened.sessionStatus.record({ status: 'compiling', message: '' })
    opened.sessionStatus.record({ status: 'ready', message: '编译完成' })
    const result = await pending
    expect(result.isError).toBeUndefined()
  })

  it('reports a compile error as isError pointing at compile_logs stderr', async () => {
    const opened = newWindow()
    const host = makeHost(undefined, opened)
    vi.mocked(host.requestOpenInUi).mockImplementation(async () => {
      opened.sessionStatus.record({ status: 'compiling', message: '' })
      opened.sessionStatus.record({ status: 'error', message: '编译失败' })
      return opened
    })
    const { call } = captureTools(host)

    const result = await call('project_open', { path: '/proj/demo', timeoutMs: 1000 })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('编译失败')
    expect(result.content[0]!.text).toContain('compile_logs')
  })

  it('surfaces a failure to open the window instead of waiting out the timeout', async () => {
    const host = makeHost()
    vi.mocked(host.requestOpenInUi).mockRejectedValue(new Error('编辑器服务端口被占用'))
    const { call } = captureTools(host)

    const result = await call('project_open', { path: '/proj/demo', timeoutMs: 1000 })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('编辑器服务端口被占用')
  })

  it('rejects an invalid project dir without pushing the renderer', async () => {
    const host = makeHost({
      validateProjectDir: vi.fn(async () => '不是有效的小程序目录'),
    })
    const { call } = captureTools(host)

    const result = await call('project_open', { path: '/not/a/project', timeoutMs: 1000 })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('不是有效的小程序目录')
    expect(host.requestOpenInUi).not.toHaveBeenCalled()
  })

  it('short-circuits when the same project is already open and ready', async () => {
    const host = makeHost({
      getProjectPath: vi.fn(() => '/proj/demo'),
      hasActiveSession: vi.fn(() => true),
    })
    host.sessionStatus.record({ status: 'ready', message: '编译完成' })
    const { call } = captureTools(host)

    const result = await call('project_open', { path: '/proj/demo', timeoutMs: 1000 })
    expect(parse(result)).toMatchObject({ phase: 'ready', note: 'project already open' })
    expect(host.requestOpenInUi).not.toHaveBeenCalled()
    expect(host.workspace.addProject).not.toHaveBeenCalled()
  })

  it('reuses the registered project name instead of re-adding a known dir', async () => {
    const opened = newWindow()
    const host = makeHost({
      hasProject: vi.fn(async () => true),
      listProjects: vi.fn(async () => [{ name: '我的小程序', path: '/proj/demo' }]),
    }, opened)
    vi.mocked(host.requestOpenInUi).mockImplementation(async () => {
      opened.sessionStatus.record({ status: 'compiling', message: '' })
      opened.sessionStatus.record({ status: 'ready', message: '' })
      return opened
    })
    const { call } = captureTools(host)

    await call('project_open', { path: '/proj/demo', timeoutMs: 1000 })
    expect(host.workspace.addProject).not.toHaveBeenCalled()
    expect(host.requestOpenInUi).toHaveBeenCalledWith({ name: '我的小程序', path: '/proj/demo' })
  })
})

describe('project_close', () => {
  it('closes the session and pushes the renderer back to the list', async () => {
    const host = makeHost({
      getProjectPath: vi.fn(() => '/proj/demo'),
      hasActiveSession: vi.fn(() => true),
    })
    const { call } = captureTools(host)

    const result = await call('project_close')
    expect(host.workspace.closeProject).toHaveBeenCalledTimes(1)
    expect(host.pinActiveProjectWindow).toHaveBeenCalledTimes(1)
    expect(
      vi.mocked(host.pinActiveProjectWindow).mock.results[0]!.value,
      'the pinned window closer must actually run — pinning without closing leaves the project window on screen with a dead session',
    ).toHaveBeenCalledTimes(1)
    expect(parse(result)).toMatchObject({ closed: true })
  })

  it('is a no-op when nothing is open', async () => {
    const host = makeHost()
    const { call } = captureTools(host)

    const result = await call('project_close')
    expect(host.workspace.closeProject).not.toHaveBeenCalled()
    expect(parse(result)).toMatchObject({ closed: false })
  })
})

describe('project_status', () => {
  it("derives 'idle' from a settled ready store when no session is live", async () => {
    const host = makeHost()
    host.sessionStatus.record({ status: 'ready', message: 'left over' })
    const { call } = captureTools(host)

    expect(parse(await call('project_status'))).toMatchObject({
      phase: 'idle',
      sessionActive: false,
      generation: 1,
    })
  })

  it("passes 'error' and 'compiling' through even without a live session", async () => {
    const host = makeHost()
    const { call } = captureTools(host)

    host.sessionStatus.record({ status: 'compiling', message: '' })
    expect(parse(await call('project_status'))).toMatchObject({ phase: 'compiling' })

    host.sessionStatus.record({ status: 'error', message: 'boom' })
    expect(parse(await call('project_status'))).toMatchObject({ phase: 'error', message: 'boom' })
  })

  it("reports 'ready' with a live session", async () => {
    const host = makeHost({
      getProjectPath: vi.fn(() => '/proj/demo'),
      hasActiveSession: vi.fn(() => true),
    })
    host.sessionStatus.record({ status: 'ready', message: '编译完成' })
    const { call } = captureTools(host)

    expect(parse(await call('project_status'))).toMatchObject({
      phase: 'ready',
      projectPath: '/proj/demo',
      sessionActive: true,
    })
  })
})

describe('project_wait_ready', () => {
  it('waits past afterGeneration for the next settled state (the rebuild-await path)', async () => {
    const host = makeHost({ hasActiveSession: vi.fn(() => true) })
    host.sessionStatus.record({ status: 'ready', message: 'before edit' })
    const { call } = captureTools(host)

    const pending = call('project_wait_ready', { afterGeneration: 1, timeoutMs: 1000 })
    host.sessionStatus.record({ status: 'ready', message: 'rebuilt' })
    expect(parse(await pending)).toMatchObject({ phase: 'ready', message: 'rebuilt', generation: 2 })
  })

  it('returns isError on timeout naming the last phase', async () => {
    const host = makeHost()
    host.sessionStatus.record({ status: 'compiling', message: '' })
    const { call } = captureTools(host)

    const result = await call('project_wait_ready', { afterGeneration: 1, timeoutMs: 20 })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/timed out.*compiling/s)
  })
})

describe('compile_logs', () => {
  it('reads incrementally by cursor with a stream filter', async () => {
    const host = makeHost()
    host.compileLogs.append({ at: 1, stream: 'stdout', text: 'building' })
    host.compileLogs.append({ at: 2, stream: 'stderr', text: 'warn: x' })
    host.compileLogs.append({ at: 3, stream: 'stderr', text: 'error: y' })
    const { call } = captureTools(host)

    const all = parse(await call('compile_logs', { cursor: 0, limit: 100 }))
    expect(all.entries).toHaveLength(3)
    expect(all.nextCursor).toBe(3)

    const errsOnly = parse(await call('compile_logs', { cursor: 1, limit: 100, stream: 'stderr' }))
    expect(errsOnly.entries).toMatchObject([
      { text: 'warn: x' },
      { text: 'error: y' },
    ])

    const nothingNew = parse(await call('compile_logs', { cursor: 3, limit: 100 }))
    expect(nothingNew.entries).toHaveLength(0)
    expect(nothingNew.nextCursor).toBe(3)
  })
})
