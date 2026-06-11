/**
 * R3 — runtime sentinel: `asMiniappRuntime` over a REAL `createWorkbenchContext`.
 *
 * The contract is a typed VIEW onto the live context, not a snapshot/projection
 * — that is what makes qdmp's permission gate work: qdmp monkey-patches
 * `ctx.workspace.openProject = wrapped` and every caller (IPC, menu, the
 * runtime view) must hit the wrapper.
 *
 * Real bugs caught:
 *  - `asMiniappRuntime` returning a projection object (copied members): the
 *    monkey-patch lands on a dead copy; the permission gate silently stops
 *    gating. → identity assertion against the real context.
 *  - `createWorkspaceService` freezing/`get`-trapping its returned object, or
 *    `openProject` becoming a non-writable property: the documented
 *    monkey-patch contract breaks at runtime even though the (non-readonly)
 *    type still compiles. → writability + interception assertions.
 *
 * GREEN today by design for the workspace half (the current literal-object
 * service is writable); RED-relevant the moment an implementer hardens the
 * service while landing R3. Electron/fs mock pattern mirrors
 * workbench-context-ignores-panels.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    mkdirSync: vi.fn(),
  }
})

let contextModule: typeof import('../services/workbench-context.js')
let runtimeModule: typeof import('./miniapp-runtime.js')

beforeEach(async () => {
  vi.resetModules()
  contextModule = await import('../services/workbench-context.js')
  runtimeModule = await import('./miniapp-runtime.js')
})

function fakeMainWindow(): import('electron').BrowserWindow {
  const wc = { id: 1, isDestroyed: () => false, send: vi.fn(), getURL: () => '' }
  return { webContents: wc } as unknown as import('electron').BrowserWindow
}

function makeContext(): import('../services/workbench-context.js').WorkbenchContext {
  return contextModule.createWorkbenchContext({
    mainWindow: fakeMainWindow(),
    preloadPath: '/fake/preload.js',
    rendererDir: '/fake/renderer',
  })
}

describe('R3 runtime sentinel: asMiniappRuntime over a real context', () => {
  it('returns the context itself (identity), so host patches reach the live runtime', () => {
    const ctx = makeContext()
    expect(runtimeModule.asMiniappRuntime(ctx)).toBe(ctx)
  })

  it('workspace.openProject is a writable own property (monkey-patch hard constraint)', () => {
    const ctx = makeContext()
    const desc = Object.getOwnPropertyDescriptor(ctx.workspace, 'openProject')
    expect(
      desc,
      'openProject must be an OWN property of the workspace service object — a prototype/getter indirection breaks `ctx.workspace.openProject = wrapped`',
    ).toBeDefined()
    expect(
      desc?.writable,
      'qdmp gates project permissions by reassigning ctx.workspace.openProject; the property must stay writable',
    ).toBe(true)
  })

  it('reassigning openProject through the runtime view intercepts calls on the real context', async () => {
    const ctx = makeContext()
    const rt = runtimeModule.asMiniappRuntime(ctx)

    const gated: string[] = []
    const original = ctx.workspace.openProject
    rt.workspace.openProject = async (projectPath: string) => {
      gated.push(projectPath)
      return { success: false, error: 'denied by qdmp permission gate' }
    }

    // The patch must be visible through BOTH references (same live object) …
    expect(ctx.workspace.openProject).not.toBe(original)
    expect(ctx.workspace.openProject).toBe(rt.workspace.openProject)

    // … and must actually intercept: the wrapper runs, the real adapter
    // pipeline (compile/session) is never entered.
    const result = await ctx.workspace.openProject('/qdmp/project')
    expect(gated).toEqual(['/qdmp/project'])
    expect(result.success).toBe(false)
    expect(result.error).toBe('denied by qdmp permission gate')
  })
})
