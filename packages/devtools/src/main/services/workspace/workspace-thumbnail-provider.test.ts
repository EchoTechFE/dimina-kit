/**
 * Contract: project thumbnails must flow through the injected
 * ProjectsProvider, not through `fs` in the workspace. Downstream hosts
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
  return {
    webContents: wc,
    isDestroyed: () => false,
  } as unknown as import('electron').BrowserWindow
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
  ;(ctx.views as unknown as { getSimulatorProjectPath: () => string | null })
    .getSimulatorProjectPath = () => ctx.workspace.getProjectPath() || '/p/x'
  return ctx
}

async function activateProject(
  ctx: ReturnType<typeof createWorkbenchContext>,
  projectPath: string,
) {
  ctx.adapter.openProject = vi.fn(async () => ({
    port: 7788,
    appInfo: { appId: `app:${projectPath}` },
    close: vi.fn(async () => {}),
  }))
  await ctx.workspace.openProject(projectPath)
}

describe('workspace-service ↔ ProjectsProvider thumbnail hooks', () => {
  /**
   * Bug caught: when the host omits saveThumbnail, workspace falls back to
   * writing PNGs into `<userData>/dimina-thumbnails`. For a downstream host's remote
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
    await activateProject(ctx, '/p/x')

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
    await activateProject(ctx, '/p/x')

    await ctx.workspace.captureThumbnail('/p/x')

    expect(saveThumbnail).toHaveBeenCalledTimes(1)
    const [dirArg, dataUrlArg] = saveThumbnail.mock.calls[0]!
    expect(dirArg).toBe('/p/x')
    expect(typeof dataUrlArg).toBe('string')
    expect(String(dataUrlArg).startsWith('data:image/png;base64,')).toBe(true)
    expect(fs.writeFileSync).not.toHaveBeenCalled()
    expect(fs.mkdirSync).not.toHaveBeenCalled()
  })

  it('rejects capture when projectPath is not the active workspace project', async () => {
    const saveThumbnail = vi.fn()
    const ctx = withSimulatorId(
      createWorkbenchContext({
        mainWindow: fakeMainWindow(),
        preloadPath: '/fake/preload.js',
        rendererDir: '/fake/renderer',
        projectsProvider: { ...makePartialProvider(), saveThumbnail },
      }),
    )
    await activateProject(ctx, '/p/current')

    await expect(ctx.workspace.captureThumbnail('/p/stale')).resolves.toBeNull()

    expect(capturePageMock).not.toHaveBeenCalled()
    expect(saveThumbnail).not.toHaveBeenCalled()
  })

  it('rejects capture when the live simulator belongs to another project session', async () => {
    const saveThumbnail = vi.fn()
    const ctx = withSimulatorId(
      createWorkbenchContext({
        mainWindow: fakeMainWindow(),
        preloadPath: '/fake/preload.js',
        rendererDir: '/fake/renderer',
        projectsProvider: { ...makePartialProvider(), saveThumbnail },
      }),
    )
    await activateProject(ctx, '/p/current')
    ;(ctx.views as unknown as { getSimulatorProjectPath: () => string | null })
      .getSimulatorProjectPath = () => '/p/previous'

    await expect(ctx.workspace.captureThumbnail('/p/current')).resolves.toBeNull()

    expect(capturePageMock).not.toHaveBeenCalled()
    expect(saveThumbnail).not.toHaveBeenCalled()
  })

  it('drops an in-flight capture when the active project changes before capturePage resolves', async () => {
    const saveThumbnail = vi.fn()
    let finishCapture!: () => void
    capturePageMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishCapture = () => resolve({ toPNG: () => PNG_BYTES })
      }),
    )
    const ctx = withSimulatorId(
      createWorkbenchContext({
        mainWindow: fakeMainWindow(),
        preloadPath: '/fake/preload.js',
        rendererDir: '/fake/renderer',
        projectsProvider: { ...makePartialProvider(), saveThumbnail },
      }),
    )
    await activateProject(ctx, '/p/current')

    const capture = ctx.workspace.captureThumbnail('/p/current')
    await ctx.workspace.closeProject()
    finishCapture()

    await expect(capture).resolves.toBeNull()
    expect(saveThumbnail).not.toHaveBeenCalled()
  })

  /**
   * When native-host mode is active the active render-host guest is the source
   * of mini-program content; the simulator WCV only holds the device-shell
   * chrome. captureThumbnail must capture the render guest, not the outer shell.
   */
  it('native-host: captures render guest WC instead of simulator WC', async () => {
    const saveThumbnail = vi.fn()
    const renderGuestCapture = vi.fn(async () => ({ toPNG: () => PNG_BYTES }))
    const renderGuestWc = { id: 99, isDestroyed: () => false, capturePage: renderGuestCapture }

    const ctx = withSimulatorId(
      createWorkbenchContext({
        mainWindow: fakeMainWindow(),
        preloadPath: '/fake/preload.js',
        rendererDir: '/fake/renderer',
        projectsProvider: { ...makePartialProvider(), saveThumbnail },
      }),
    )
    // Wire a minimal bridge handle with native-host on and the render guest available.
    ;(ctx as unknown as { bridge: unknown }).bridge = {
      isNativeHost: () => true,
      getActiveRenderWc: () => renderGuestWc,
    }
    await activateProject(ctx, '/p/x')

    const dataUrl = await ctx.workspace.captureThumbnail('/p/x')

    expect(renderGuestCapture).toHaveBeenCalledTimes(1)
    expect(capturePageMock).not.toHaveBeenCalled()
    expect(typeof dataUrl).toBe('string')
    expect(String(dataUrl).startsWith('data:image/png;base64,')).toBe(true)
    expect(saveThumbnail).toHaveBeenCalledWith('/p/x', dataUrl)
  })

  /**
   * When native-host mode is active but the render guest is not yet available
   * (not mounted, mid page-switch, or destroyed), captureThumbnail returns null
   * rather than falling back to the device-shell WCV. A device-shell frame is
   * not a valid page thumbnail — it only holds phone chrome, not page content.
   */
  it('native-host: returns null when render guest is unavailable (no device-shell fallback)', async () => {
    const saveThumbnail = vi.fn()
    const ctx = withSimulatorId(
      createWorkbenchContext({
        mainWindow: fakeMainWindow(),
        preloadPath: '/fake/preload.js',
        rendererDir: '/fake/renderer',
        projectsProvider: { ...makePartialProvider(), saveThumbnail },
      }),
    )
    // Bridge reports native-host mode but no active render guest.
    ;(ctx as unknown as { bridge: unknown }).bridge = {
      isNativeHost: () => true,
      getActiveRenderWc: () => null,
    }
    await activateProject(ctx, '/p/x')

    const result = await ctx.workspace.captureThumbnail('/p/x')

    expect(result).toBeNull()
    expect(capturePageMock).not.toHaveBeenCalled()
    expect(saveThumbnail).not.toHaveBeenCalled()
  })

  /**
   * When the render guest changes between capture start and capture resolve
   * (mid page-switch), captureThumbnail returns null and does not persist
   * the stale frame. The post-capture getActiveRenderWc() check enforces this.
   *
   * Failure predicate: removing the staleness guard that compares
   * getActiveRenderWc() after capture against the captured target allows
   * saveThumbnail to be called with a frame from the wrong page — this test
   * catches that regression.
   */
  it('native-host: returns null when render guest changes mid-capture (staleness guard)', async () => {
    const saveThumbnail = vi.fn()
    const guestACapture = vi.fn(async () => ({ toPNG: () => PNG_BYTES }))
    const guestA = { id: 10, isDestroyed: () => false, capturePage: guestACapture }
    const guestB = { id: 11, isDestroyed: () => false, capturePage: vi.fn() }

    let getActiveRenderWcCalls = 0
    const ctx = withSimulatorId(
      createWorkbenchContext({
        mainWindow: fakeMainWindow(),
        preloadPath: '/fake/preload.js',
        rendererDir: '/fake/renderer',
        projectsProvider: { ...makePartialProvider(), saveThumbnail },
      }),
    )
    // First call selects guestA as the capture target. The post-capture
    // staleness check calls getActiveRenderWc() again; returning guestB at
    // that point simulates a page navigation completing during the capture.
    ;(ctx as unknown as { bridge: unknown }).bridge = {
      isNativeHost: () => true,
      getActiveRenderWc: () => (getActiveRenderWcCalls++ === 0 ? guestA : guestB),
    }
    await activateProject(ctx, '/p/x')

    const result = await ctx.workspace.captureThumbnail('/p/x')

    // guestA.capturePage resolved, but the staleness check saw guestB — null.
    expect(guestACapture).toHaveBeenCalledTimes(1)
    expect(result).toBeNull()
    expect(saveThumbnail).not.toHaveBeenCalled()
  })

  /**
   * Capture targets (simulator WC or render guest) can be destroyed before
   * capturePage is called — e.g. the WC was torn down by a project switch that
   * arrived between the staleness-snapshot and the actual capture call. Calling
   * capturePage() on a destroyed WebContents throws in Electron; the guard must
   * return null without calling capturePage at all, rather than relying on the
   * try/catch to swallow the throw. The distinction matters because a spy on
   * the destroyed WC lets us verify the guard fires at the right point.
   *
   * Failure predicate: without an isDestroyed() pre-check, capturePage is still
   * called on the destroyed WC mock (which resolves successfully in the test
   * double, unlike real Electron), causing saveThumbnail to be called with a
   * stale frame — both spy assertions fire red.
   */
  it('returns null without calling capturePage when the simulator WC is already destroyed', async () => {
    const saveThumbnail = vi.fn()
    const captureOnDestroyed = vi.fn(async () => ({ toPNG: () => PNG_BYTES }))
    const destroyedSimWc = {
      id: 77,
      isDestroyed: () => true,
      capturePage: captureOnDestroyed,
    }
    const ctx = createWorkbenchContext({
      mainWindow: fakeMainWindow(),
      preloadPath: '/fake/preload.js',
      rendererDir: '/fake/renderer',
      projectsProvider: { ...makePartialProvider(), saveThumbnail },
    })
    ;(ctx.views as unknown as { getSimulatorWebContents: () => unknown })
      .getSimulatorWebContents = () => destroyedSimWc
    ;(ctx.views as unknown as { getSimulatorProjectPath: () => string | null })
      .getSimulatorProjectPath = () => '/p/x'
    ctx.adapter.openProject = vi.fn(async () => ({
      port: 7788,
      appInfo: { appId: 'app:/p/x' },
      close: vi.fn(async () => {}),
    }))
    await ctx.workspace.openProject('/p/x')

    const result = await ctx.workspace.captureThumbnail('/p/x')

    expect(result).toBeNull()
    expect(
      captureOnDestroyed,
      'capturePage must not be called on an already-destroyed WebContents',
    ).not.toHaveBeenCalled()
    expect(saveThumbnail).not.toHaveBeenCalled()
  })

  /**
   * Native-host: same pre-check for the render guest path. The guest can be
   * destroyed between the pre-capture liveness snapshot and the capturePage
   * call (e.g. a page navigation tore it down). Calling capturePage on a
   * destroyed render guest is the same bug as the simulator-WC case above —
   * prevented by an isDestroyed() guard, not by relying on the catch branch.
   *
   * Failure predicate: without the guard, captureOnDestroyedGuest is called
   * and (in the mock) resolves successfully, so saveThumbnail is called — red.
   */
  it('native-host: returns null without calling capturePage when render guest is already destroyed', async () => {
    const saveThumbnail = vi.fn()
    const captureOnDestroyedGuest = vi.fn(async () => ({ toPNG: () => PNG_BYTES }))
    const destroyedGuest = {
      id: 88,
      isDestroyed: () => true,
      capturePage: captureOnDestroyedGuest,
    }
    const ctx = withSimulatorId(
      createWorkbenchContext({
        mainWindow: fakeMainWindow(),
        preloadPath: '/fake/preload.js',
        rendererDir: '/fake/renderer',
        projectsProvider: { ...makePartialProvider(), saveThumbnail },
      }),
    )
    ;(ctx as unknown as { bridge: unknown }).bridge = {
      isNativeHost: () => true,
      getActiveRenderWc: () => destroyedGuest,
    }
    ctx.adapter.openProject = vi.fn(async () => ({
      port: 7788,
      appInfo: { appId: 'app:/p/x' },
      close: vi.fn(async () => {}),
    }))
    await ctx.workspace.openProject('/p/x')

    const result = await ctx.workspace.captureThumbnail('/p/x')

    expect(result).toBeNull()
    expect(
      captureOnDestroyedGuest,
      'capturePage must not be called on an already-destroyed render guest',
    ).not.toHaveBeenCalled()
    expect(saveThumbnail).not.toHaveBeenCalled()
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
