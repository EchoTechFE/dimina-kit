/**
 * Runtime enforcement of the REQUIRED `appId` at the REAL boundary (where the
 * adapter's session enters the workbench), not at `getSession()` read time.
 *
 * `appId: string` is REQUIRED on `MiniappSessionAppInfo` (the renderer
 * genuinely depends on it; the devkit adapter always returns one, fallback
 * included; a custom adapter that returns none hands the renderer a session it
 * cannot drive). This file is the runtime half of that contract; the
 * type-level half lives in miniapp-session-appinfo.test.ts.
 *
 * Locked contract (this file is the spec) — `WorkspaceService.openProject`:
 *
 *  - validates `session.appInfo` THE MOMENT `ctx.adapter.openProject`
 *    resolves (the adapter-return boundary). `appInfo` must be an object
 *    carrying a string `appId`. Validation failures are REPORTED, not thrown:
 *    `openProject` resolves `{ success: false, error }` with an `error`
 *    message that names `appId` so an adapter author can find the problem.
 *  - REJECTION MUST NOT LEAK THE SESSION: the adapter already created a live
 *    session (compile watcher, dev-server port). The workbench must `close()`
 *    that session before reporting failure, and must retain NO active session:
 *    `getSession()` → null, `hasActiveSession()` → false,
 *    `getProjectPath()` → ''.
 *  - a failing `close()` during that cleanup must not mask the validation
 *    error (still `{ success: false, error: …appId… }`, still no throw).
 *  - a rejected open leaves the service reusable: the NEXT `openProject`
 *    against a well-behaved adapter result succeeds normally.
 *  - valid `appId` keeps today's behavior byte-for-byte:
 *    `{ success: true, port, appInfo }` and the session is retained.
 *
 * Electron/fs mocks: same pattern as workspace-provider-injection.test.ts
 * (mock electron + fs; drive through the PUBLIC `ctx.workspace` surface built
 * by createWorkbenchContext).
 *
 * Guards that openProject validates `session.appInfo` instead of forwarding it
 * blindly — an invalid appInfo must yield a rejection, not a retained session.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { CompilationAdapter, ProjectSession } from '../../../shared/types.js'

// Minimal Electron stub — workspace-service indirectly imports modules that
// import from 'electron' (loadWorkbenchSettings, view-manager). The stub just
// needs to not throw.
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

beforeEach(async () => {
  vi.resetModules()
  ;({ createWorkbenchContext } = await import('../workbench-context.js'))
})

function fakeMainWindow(): import('electron').BrowserWindow {
  const wc = {
    id: 1,
    isDestroyed: () => false,
    send: vi.fn(),
    getURL: () => '',
  }
  return {
    webContents: wc,
    isDestroyed: () => false,
  } as unknown as import('electron').BrowserWindow
}

type StubSession = ProjectSession & { close: ReturnType<typeof vi.fn> }

function makeSession(appInfo: unknown, close?: () => Promise<void>): StubSession {
  return {
    close: vi.fn(close ?? (async () => undefined)),
    port: 4321,
    appInfo,
  } as StubSession
}

/** Build a real context whose adapter returns the given sessions in order. */
function makeWorkspace(...sessions: StubSession[]) {
  const openProject = vi.fn(async () => {
    const next = sessions.shift()
    if (!next) throw new Error('test adapter exhausted')
    return next
  })
  const adapter: CompilationAdapter = { openProject }
  const ctx = createWorkbenchContext({
    mainWindow: fakeMainWindow(),
    preloadPath: '/fake/preload.js',
    rendererDir: '/fake/renderer',
    adapter,
    projectsProvider: {
      listProjects: vi.fn(() => []),
      addProject: vi.fn(),
      removeProject: vi.fn(),
      validateProjectDir: vi.fn(() => null),
      updateLastOpened: vi.fn(),
    },
  })
  return { workspace: ctx.workspace, openProject }
}

describe('①(增量) openProject rejects an adapter session whose appInfo lacks a usable appId', () => {
  it.each([
    ['appId missing', { name: 'demo', path: '/proj/demo' }],
    ['appId not a string', { appId: 42, name: 'demo', path: '/proj/demo' }],
    ['appInfo is null', null],
    ['appInfo is undefined', undefined],
    ['appInfo is a primitive', 'legacy-app-info-string'],
  ])('%s → resolves { success: false, error names appId } — never throws', async (_label, appInfo) => {
    // BUG CAUGHT (today): the malformed appInfo rides `{ success: true }` into
    // the renderer, which then dereferences `appInfo.appId` — the failure
    // surfaces far from the adapter that caused it, as renderer breakage.
    const { workspace } = makeWorkspace(makeSession(appInfo))

    const result = await workspace.openProject('/proj/demo')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/appId/)
  })

  it('rejection CLOSES the adapter-created session and retains nothing (no leak)', async () => {
    // An implementation that validates and returns early leaks the live
    // session the adapter already spun up — its compile
    // watcher and dev-server port stay alive with no owner and no way to
    // close them (the workspace never recorded the session).
    const session = makeSession({ name: 'no-app-id' })
    const { workspace } = makeWorkspace(session)

    const result = await workspace.openProject('/proj/demo')

    expect(result.success).toBe(false)
    expect(session.close).toHaveBeenCalledTimes(1)
    // Boundary pin: the failure already surfaced from openProject itself —
    // reads NEVER throw and see no residue (validation does NOT live in
    // getSession).
    expect(workspace.getSession()).toBeNull()
    expect(workspace.hasActiveSession()).toBe(false)
    expect(workspace.getProjectPath()).toBe('')
  })

  it('a close() failure during rejection cleanup does not mask the validation error', async () => {
    // BUG CAUGHT: `await session.close()` rethrowing would turn the helpful
    // "your adapter returned no appId" report into an unrelated rejection (or
    // an unhandled throw) — the cleanup is best-effort, the report is law.
    const session = makeSession({ appId: 999 }, async () => {
      throw new Error('close boom')
    })
    const { workspace } = makeWorkspace(session)

    const result = await workspace.openProject('/proj/demo')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/appId/)
    expect(session.close).toHaveBeenCalledTimes(1)
    expect(workspace.hasActiveSession()).toBe(false)
  })

  it('a rejected open leaves the workspace reusable: the next valid open succeeds', async () => {
    // BUG CAUGHT: rejection leaving half-initialized state (projectPath set,
    // referer cached, session recorded) that wedges every subsequent open.
    const bad = makeSession({})
    const good = makeSession({ appId: 'wx-good', name: 'demo', path: '/proj/demo' })
    const { workspace } = makeWorkspace(bad, good)

    const first = await workspace.openProject('/proj/demo')
    expect(first.success).toBe(false)

    const second = await workspace.openProject('/proj/demo')
    expect(second.success).toBe(true)
    expect(workspace.hasActiveSession()).toBe(true)
    expect(workspace.getProjectPath()).toBe('/proj/demo')
  })
})

describe('①(增量) valid appId keeps the existing open flow byte-for-byte (regression pins)', () => {
  it('string appId → { success: true, port, appInfo } and the session is retained', async () => {
    const appInfo = { appId: 'wx123', name: 'demo', path: '/proj/demo' }
    const { workspace, openProject } = makeWorkspace(makeSession(appInfo))

    const result = await workspace.openProject('/proj/demo')

    expect(result).toMatchObject({ success: true, port: 4321, appInfo })
    expect(openProject).toHaveBeenCalledTimes(1)
    expect(workspace.hasActiveSession()).toBe(true)
    expect(workspace.getSession()?.appInfo).toEqual(appInfo)
  })

  it('appId alone is sufficient — name/path/appName stay optional at runtime too', async () => {
    // Mirrors the revised type contract: REQUIRED is appId and only appId.
    // BUG CAUGHT: over-validation (requiring name/path) would reject custom
    // adapters that legitimately supply nothing but the appId.
    const { workspace } = makeWorkspace(makeSession({ appId: 'wx-min' }))

    const result = await workspace.openProject('/proj/demo')

    expect(result.success).toBe(true)
    expect(workspace.hasActiveSession()).toBe(true)
  })
})
