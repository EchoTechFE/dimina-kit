/**
 * Phase 2 contract: project thumbnails must flow through the injected
 * ProjectsProvider, not through `fs` in the workspace. Hosts like qdmp
 * keep projects in the cloud, so the local `<userData>/...thumbnails`
 * cache is the wrong source of truth for them.
 *
 * Two new optional ProjectsProvider hooks are introduced:
 *   - saveThumbnail(dirPath, imageDataUrl): persist a captured screenshot
 *   - getThumbnail(dirPath): read the most recent thumbnail or null
 *
 * Both default to no-op / null when omitted. WorkspaceService.getThumbnail
 * also changes from sync `string | null` to `Promise<string | null>` to
 * match the rest of the provider-driven surface (listProjects et al.).
 *
 * captureThumbnail keeps its `Promise<string | null>` signature but its
 * internals now go through the provider instead of writing to local fs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Project } from '../projects/project-repository.js'

// Minimal NativeImage stub: toPNG() returns a 4-byte PNG magic header.
// 0x89 'P' 'N' 'G' → base64 'iVBORw==' (close enough — the test only checks
// the data:image/png;base64, prefix, not the actual bytes).
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const capturePageMock = vi.fn(async () => ({ toPNG: () => PNG_BYTES }))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/userdata'), isPackaged: true },
  webContents: {
    // workspace-service guards capturePage with `wc.isDestroyed()`, so the
    // stub must implement it (mock-infra fix; not a contract change).
    fromId: vi.fn((id: number) =>
      id === 1
        ? { id: 1, isDestroyed: () => false, capturePage: capturePageMock }
        : null,
    ),
  },
  default: {},
}))

// Spy on every fs entry point the (now-removed) local thumbnail path used.
// Each test asserts these stay at zero calls — that's the whole point of
// routing through the provider.
vi.mock('fs', async () => {
  const real = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...real,
    default: real,
    existsSync: vi.fn(() => false),
    statSync: vi.fn(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }),
    readFileSync: vi.fn(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  }
})

let createWorkbenchContext: typeof import('../workbench-context.js').createWorkbenchContext
let fs: typeof import('fs')

beforeEach(async () => {
  vi.resetModules()
  ;({ createWorkbenchContext } = await import('../workbench-context.js'))
  fs = await import('fs')
  vi.mocked(fs.existsSync).mockClear()
  vi.mocked(fs.statSync).mockClear()
  vi.mocked(fs.readFileSync).mockClear()
  vi.mocked(fs.writeFileSync).mockClear()
  vi.mocked(fs.mkdirSync).mockClear()
  capturePageMock.mockClear()
})

function fakeMainWindow(): import('electron').BrowserWindow {
  const wc = { id: 1, isDestroyed: () => false, send: vi.fn(), getURL: () => '' }
  return { webContents: wc } as unknown as import('electron').BrowserWindow
}

const sampleProject: Project = { name: 'x', path: '/p/x', lastOpened: null }

function makePartialProvider() {
  return {
    listProjects: vi.fn(() => [sampleProject]),
    addProject: vi.fn((p: string) => ({ ...sampleProject, path: p })),
    removeProject: vi.fn(),
  }
}

/** Force the simulator webContents so the capturePage path is reachable. */
function withSimulatorId(ctx: ReturnType<typeof createWorkbenchContext>) {
  const fakeWc = { id: 1, isDestroyed: () => false, capturePage: capturePageMock }
  ;(ctx.views as unknown as { getSimulatorWebContents: () => unknown })
    .getSimulatorWebContents = () => fakeWc
  return ctx
}

describe('workspace-service ↔ ProjectsProvider thumbnail hooks', () => {
  /**
   * Bug caught: when the host omits saveThumbnail, workspace falls back to
   * writing PNGs into `<userData>/dimina-thumbnails`. For a qdmp remote
   * project the dirPath isn't a real local path; the local cache becomes
   * the de-facto store and the host never sees the screenshot.
   */
  it('omits saveThumbnail → captureThumbnail is a silent no-op, no fs writes', async () => {
    const injected = makePartialProvider()
    const ctx = withSimulatorId(
      createWorkbenchContext({
        mainWindow: fakeMainWindow(),
        preloadPath: '/fake/preload.js',
        rendererDir: '/fake/renderer',
        projectsProvider: injected,
      }),
    )

    await expect(ctx.workspace.captureThumbnail('/p/x')).resolves.not.toThrow()
    expect(fs.writeFileSync).not.toHaveBeenCalled()
    expect(fs.mkdirSync).not.toHaveBeenCalled()
  })

  /**
   * Bug caught: when the host omits getThumbnail, workspace reads PNGs from
   * the local `<userData>/dimina-thumbnails` cache. For a remote project
   * this surfaces a stale or wrong-host thumbnail (or someone else's
   * screenshot at the same path).
   */
  it('omits getThumbnail → workspace returns null without touching fs', async () => {
    const injected = makePartialProvider()
    const ctx = createWorkbenchContext({
      mainWindow: fakeMainWindow(),
      preloadPath: '/fake/preload.js',
      rendererDir: '/fake/renderer',
      projectsProvider: injected,
    })

    const result = await ctx.workspace.getThumbnail('/p/x')
    expect(result).toBeNull()
    expect(fs.readFileSync).not.toHaveBeenCalled()
    expect(fs.existsSync).not.toHaveBeenCalled()
  })

  /**
   * Bug caught: even when the host provides saveThumbnail, workspace ALSO
   * writes to local fs (double-source-of-truth). The provider must be the
   * only sink, and it must receive a `data:image/png;base64,...` string —
   * not a Buffer, not a file path — so the host can ship it as-is.
   */
  it('provides saveThumbnail → captureThumbnail delegates with dataUrl, no fs writes', async () => {
    const saveThumbnail = vi.fn()
    const injected = { ...makePartialProvider(), saveThumbnail }
    const ctx = withSimulatorId(
      createWorkbenchContext({
        mainWindow: fakeMainWindow(),
        preloadPath: '/fake/preload.js',
        rendererDir: '/fake/renderer',
        projectsProvider: injected,
      }),
    )

    await ctx.workspace.captureThumbnail('/p/x')

    expect(saveThumbnail).toHaveBeenCalledTimes(1)
    const [dirArg, dataUrlArg] = saveThumbnail.mock.calls[0]!
    expect(dirArg).toBe('/p/x')
    expect(typeof dataUrlArg).toBe('string')
    expect(String(dataUrlArg).startsWith('data:image/png;base64,')).toBe(true)
    expect(fs.writeFileSync).not.toHaveBeenCalled()
    expect(fs.mkdirSync).not.toHaveBeenCalled()
  })

  /**
   * Bug caught: workspace ignores injected.getThumbnail and still reads
   * from local fs, returning either null or someone else's cached PNG
   * instead of the cloud thumbnail the host knows about.
   */
  it('provides getThumbnail → workspace returns provider value verbatim, no fs reads', async () => {
    const cloudUrl = 'data:image/png;base64,REMOTE-CLOUD-PAYLOAD'
    const getThumbnail = vi.fn(async () => cloudUrl)
    const injected = { ...makePartialProvider(), getThumbnail }
    const ctx = createWorkbenchContext({
      mainWindow: fakeMainWindow(),
      preloadPath: '/fake/preload.js',
      rendererDir: '/fake/renderer',
      projectsProvider: injected,
    })

    const result = await ctx.workspace.getThumbnail('/p/x')
    expect(result).toBe(cloudUrl)
    expect(getThumbnail).toHaveBeenCalledTimes(1)
    expect(getThumbnail).toHaveBeenCalledWith('/p/x')
    expect(fs.readFileSync).not.toHaveBeenCalled()
    expect(fs.existsSync).not.toHaveBeenCalled()
  })
})
