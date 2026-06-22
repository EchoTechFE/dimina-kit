/**
 * workspace-service `onLog` wiring contract (dmcc 日志链路).
 *
 * Contract under test:
 *  - `openProject` passes an `onLog` callback to `ctx.adapter.openProject`,
 *    right next to the existing `onRebuild` wiring. Transport note (verified):
 *    `CompilationAdapter.openProject` opts are
 *    `Omit<OpenProjectOptions, 'containerDir' | 'outputDir'>` (shared/types.ts)
 *    and `default-adapter.ts` spreads `...opts`, so once devkit adds `onLog`
 *    to `OpenProjectOptions` it flows through with ZERO adapter changes.
 *  - Each devkit log entry `{ stream, text }` is forwarded to
 *    `ctx.notify.compileLog({ stream, text, at: Date.now() })` — the
 *    workspace layer stamps the wall-clock `at`, the text passes verbatim
 *    (filtering already happened in devkit's filterDmccLogLine).
 *
 * Harness lifted from workspace-hot-reload.test.ts (electron/fs/repo mocks,
 * fake WorkbenchContext, captured adapter callbacks).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => {
  const app = {
    getPath: vi.fn(() => '/tmp/dimina-test-userdata'),
    isPackaged: true,
  }
  const nativeTheme = { themeSource: 'system' }
  return { app, nativeTheme, default: {} }
})

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

type WorkbenchContext = import('../workbench-context.js').WorkbenchContext
let createWorkspaceService: typeof import('./workspace-service.js').createWorkspaceService

interface DevkitLogEntry {
  stream: 'stdout' | 'stderr'
  text: string
}

/** The notifier-side payload the workspace layer must produce. */
interface CompileLogPayload {
  at: number
  stream: 'stdout' | 'stderr'
  text: string
}

function stubProjectsProvider(): import('../projects/types.js').ProjectsProvider {
  return {
    listProjects: vi.fn(() => []),
    addProject: vi.fn((p: string) => ({ name: 'fake', path: p, lastOpened: null })),
    removeProject: vi.fn(),
  }
}

function makeHarness() {
  const projectStatus = vi.fn()
  const compileLog = vi.fn<(payload: CompileLogPayload) => void>()

  let capturedOnLog: ((entry: DevkitLogEntry) => void) | null = null
  const fakeSession = {
    port: 12345,
    appInfo: { appId: 'fakeApp' },
    close: vi.fn(() => Promise.resolve()),
  }
  const adapter = {
    openProject: vi.fn(
      async (opts: { onLog?: (entry: DevkitLogEntry) => void }) => {
        capturedOnLog = opts.onLog ?? null
        return fakeSession
      },
    ),
  }

  const ctx = {
    adapter,
    notify: { projectStatus, compileLog },
    views: { disposeAll: vi.fn() },
    projectsProvider: stubProjectsProvider(),
  } as unknown as WorkbenchContext

  return {
    ctx,
    compileLog,
    projectStatus,
    getCapturedOnLog: () => capturedOnLog,
  }
}

beforeEach(async () => {
  vi.resetModules()
  ;({ createWorkspaceService } = await import('./workspace-service.js'))
})

describe('workspace-service: adapter onLog → notify.compileLog', () => {
  it('hands an onLog callback to the adapter (next to onRebuild)', async () => {
    const harness = makeHarness()
    const workspace = createWorkspaceService(harness.ctx)

    const result = await workspace.openProject('/tmp/fakeProj')
    expect(result.success).toBe(true)

    expect(
      harness.getCapturedOnLog(),
      'openProject must pass onLog to ctx.adapter.openProject — the dmcc log line transport into the main process',
    ).toBeTypeOf('function')
  })

  it('forwards each entry as { stream, text, at: Date.now() } to notify.compileLog', async () => {
    const harness = makeHarness()
    const workspace = createWorkspaceService(harness.ctx)
    await workspace.openProject('/tmp/fakeProj')
    const onLog = harness.getCapturedOnLog()
    expect(onLog).toBeTypeOf('function')

    const before = Date.now()
    onLog!({
      stream: 'stderr',
      text: '[logic] esbuild 转换失败 /tmp/fakeProj/pages/index/index.js: Transform failed with 1 error:',
    })
    const after = Date.now()

    expect(harness.compileLog).toHaveBeenCalledTimes(1)
    const payload = harness.compileLog.mock.calls[0]![0]
    expect(payload.stream).toBe('stderr')
    expect(
      payload.text,
      'the line text must pass through verbatim — filtering already happened in devkit',
    ).toBe('[logic] esbuild 转换失败 /tmp/fakeProj/pages/index/index.js: Transform failed with 1 error:')
    expect(
      payload.at,
      'the workspace layer must stamp the wall-clock capture time (Date.now)',
    ).toBeGreaterThanOrEqual(before)
    expect(payload.at).toBeLessThanOrEqual(after)
  })

  it('forwards multiple lines 1:1 in arrival order', async () => {
    const harness = makeHarness()
    const workspace = createWorkspaceService(harness.ctx)
    await workspace.openProject('/tmp/fakeProj')
    const onLog = harness.getCapturedOnLog()
    expect(onLog).toBeTypeOf('function')

    onLog!({ stream: 'stdout', text: '✔ 收集配置信息' })
    onLog!({ stream: 'stdout', text: '✔ 输出编译产物' })
    onLog!({ stream: 'stderr', text: '✖ 编译页面逻辑 [FAILED: …]' })

    expect(harness.compileLog).toHaveBeenCalledTimes(3)
    expect(harness.compileLog.mock.calls.map((c) => c[0].text)).toEqual([
      '✔ 收集配置信息',
      '✔ 输出编译产物',
      '✖ 编译页面逻辑 [FAILED: …]',
    ])
  })

  it('does NOT route log lines through projectStatus (the status contract stays event-shaped)', async () => {
    const harness = makeHarness()
    const workspace = createWorkspaceService(harness.ctx)
    await workspace.openProject('/tmp/fakeProj')
    const onLog = harness.getCapturedOnLog()
    expect(onLog).toBeTypeOf('function')

    const statusCallsBefore = harness.projectStatus.mock.calls.length
    onLog!({ stream: 'stdout', text: '✔ 收集配置信息' })

    expect(
      harness.projectStatus.mock.calls.length,
      'a log line must not synthesize a projectStatus payload — wave-1 pins compileEvents to one entry per projectStatus',
    ).toBe(statusCallsBefore)
  })
})

/**
 * If the onLog closure handed to the adapter carries no session generation,
 * then after closeProject (or switching projects) a LATE log line from the old
 * session's compile worker still flows into notify.compileLog, polluting the
 * (new) project's compile panel with lines from a project the user already
 * closed. The behavioural pin: a stale session's onLog must become a no-op once
 * that session is no longer the active one. (Implementation form free —
 * generation counter, closure flag, whatever — only the drop behaviour is
 * pinned.)
 */
describe('workspace-service: stale onLog after close/switch is dropped', () => {
  it('drops late log lines arriving through a CLOSED session’s onLog', async () => {
    const harness = makeHarness()
    const workspace = createWorkspaceService(harness.ctx)

    await workspace.openProject('/tmp/fakeProj-p1')
    const staleOnLog = harness.getCapturedOnLog()
    expect(staleOnLog).toBeTypeOf('function')

    await workspace.closeProject()
    harness.compileLog.mockClear()

    // The forked compile worker dies asynchronously — buffered stdout/stderr
    // lines can still arrive through the old closure AFTER closeProject.
    staleOnLog!({ stream: 'stdout', text: '✔ 迟到的日志行（项目已关闭）' })

    expect(
      harness.compileLog,
      'a log line arriving through a CLOSED session’s onLog must be dropped — forwarding it pollutes whatever '
      + 'project the user opens next with a dead project’s compile output',
    ).not.toHaveBeenCalled()
  })

  it('drops the PREVIOUS project’s late log lines after switching, while the new session still forwards', async () => {
    const harness = makeHarness()
    const workspace = createWorkspaceService(harness.ctx)

    await workspace.openProject('/tmp/fakeProj-p1')
    const p1OnLog = harness.getCapturedOnLog()
    expect(p1OnLog).toBeTypeOf('function')

    await workspace.openProject('/tmp/fakeProj-p2')
    const p2OnLog = harness.getCapturedOnLog()
    expect(p2OnLog).toBeTypeOf('function')

    harness.compileLog.mockClear()

    // P1's worker teardown straggler must NOT reach the panel…
    p1OnLog!({ stream: 'stderr', text: '✖ P1 的迟到日志行' })
    expect(
      harness.compileLog,
      'a stale onLog from the project opened BEFORE the switch must be dropped — today it lands in P2’s '
      + 'compile-log timeline as if P2 produced it',
    ).not.toHaveBeenCalled()

    // …while the ACTIVE session's onLog keeps forwarding 1:1.
    p2OnLog!({ stream: 'stdout', text: '✔ P2 编译中' })
    expect(
      harness.compileLog,
      'the active session’s onLog must keep forwarding — the staleness guard must not fail closed',
    ).toHaveBeenCalledTimes(1)
    expect(harness.compileLog.mock.calls[0]![0].text).toBe('✔ P2 编译中')
  })

  /**
   * On the project-SWITCH path `openProject(P2)` disposes P1's session BEFORE
   * claiming the new log generation (`++logGeneration` happens after
   * `await disposeSession()`), so
   * while P1's `session.close()` is still executing, P1's onLog closure still
   * sees `sessionGeneration === logGeneration` and forwards. A compile worker
   * being torn down is exactly when it flushes its buffered stdout/stderr —
   * those teardown lines land in P2's compile-log timeline. The pin: a line
   * fired DURING the old session's close must be dropped; P2's own onLog must
   * still forward (no fail-closed).
   */
  it('drops a line fired DURING the old session’s close() on the switch path — teardown flush must not enter P2’s timeline', async () => {
    const harness = makeHarness()
    const workspace = createWorkspaceService(harness.ctx)

    await workspace.openProject('/tmp/fakeProj-p1')
    const p1OnLog = harness.getCapturedOnLog()
    expect(p1OnLog).toBeTypeOf('function')

    // Reach the fake session the adapter handed back for P1 and make its
    // close() flush a buffered log line synchronously mid-teardown — the
    // compile worker's dying-breath stdout flush, compressed into the mock.
    const adapterMock = (
      harness.ctx as unknown as {
        adapter: { openProject: ReturnType<typeof vi.fn> }
      }
    ).adapter.openProject
    const p1Session = (await adapterMock.mock.results[0]!.value) as {
      close: ReturnType<typeof vi.fn>
    }
    p1Session.close.mockImplementation(() => {
      p1OnLog!({ stream: 'stderr', text: '✖ P1 teardown 冲刷的迟到日志' })
      return Promise.resolve()
    })

    harness.compileLog.mockClear()
    await workspace.openProject('/tmp/fakeProj-p2')

    expect(
      harness.compileLog,
      'a log line fired while the OLD session’s close() is still executing must be dropped — on the switch '
      + 'path the generation is claimed only AFTER disposeSession(), so today the teardown flush still passes '
      + 'the staleness guard and pollutes P2’s compile-log timeline',
    ).not.toHaveBeenCalled()

    // The guard must not fail closed: P2's own onLog keeps forwarding 1:1.
    const p2OnLog = harness.getCapturedOnLog()
    expect(p2OnLog).toBeTypeOf('function')
    p2OnLog!({ stream: 'stdout', text: '✔ P2 编译中' })
    expect(
      harness.compileLog,
      'the NEW session’s onLog must keep forwarding after the switch — dropping teardown stragglers must not '
      + 'silence the active project',
    ).toHaveBeenCalledTimes(1)
    expect(harness.compileLog.mock.calls[0]![0].text).toBe('✔ P2 编译中')
  })
})
