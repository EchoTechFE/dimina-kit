/**
 * Host toolbar framework runtime is SESSION-RESIDENT, not delivered via the
 * toolbar WCV's `webPreferences.preload`. If the height-advertiser preload
 * rode on `webPreferences.preload`, a host calling
 * `setPreloadPath(<its own preload>)` would REPLACE the advertiser and the
 * strip height would collapse to 0 (a real downstream incident).
 *
 * Contract:
 *  - the toolbar WCV stays on the defaultSession (no partition),
 *  - its creation injects the `'--dimina-host-toolbar'` marker via
 *    `webPreferences.additionalArguments`,
 *  - the framework registers its toolbar-runtime preload ONCE per session via
 *    `session.defaultSession.registerPreloadScript({ type: 'frame', filePath })`
 *    (filePath resolved by the paths layer → ASAR-safe absolute path),
 *  - registrations are REF-COUNTED across coexisting ViewManagers: only the
 *    LAST disposeAll unregisters,
 *  - `setPreloadPath` now means "the HOST's own webPreferences.preload"; null
 *    means "no host preload" — it never was and never restores the advertiser,
 *  - `webPreferences.preload` no longer carries the built-in advertiser at all.
 *
 * Electron mock mirrors host-toolbar.test.ts (same WebContentsView capture +
 * makeContext shape) extended with: constructor-options capture (we must
 * assert webPreferences) and `session.defaultSession.registerPreloadScript /
 * unregisterPreloadScript` spies. Module state (the session registration
 * ref-count) is per-import, so every test re-imports view-manager after
 * `vi.resetModules()`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'path'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'
import { hostToolbarBounds } from './placement-test-driver.js'

/** The process-level marker injected into the toolbar WCV's argv. */
const MARKER = '--dimina-host-toolbar'

const STUB_RUNTIME_PRELOAD = '/stub/host-toolbar-runtime-preload.cjs'
const STUB_LEGACY_ADVERTISER_PRELOAD = '/stub/host-toolbar-preload.cjs'

type StubWebContents = {
  destroyed: boolean
  id: number
  isDestroyed: () => boolean
  close: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
}
type StubView = {
  webPreferences: Record<string, unknown> | undefined
  webContents: StubWebContents
  setBounds: ReturnType<typeof vi.fn>
  setBackgroundColor: ReturnType<typeof vi.fn>
}

const h = vi.hoisted(() => {
  const registerPreloadScript = vi.fn(
    (_script: { type?: string; filePath?: string; id?: string }) => 'stub-preload-script-id',
  )
  const unregisterPreloadScript = vi.fn((_id: string) => {})
  const constructed: unknown[] = []
  return { registerPreloadScript, unregisterPreloadScript, constructed }
})

vi.mock('electron', () => {
  let nextId = 1
  class WebContentsView {
    webPreferences: Record<string, unknown> | undefined
    webContents: StubWebContents
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
    constructor(opts?: { webPreferences?: Record<string, unknown> }) {
      // Capture the constructor options — the marker/preload/partition
      // assertions below all read this.
      this.webPreferences = opts?.webPreferences
      const id = nextId++
      this.webContents = {
        destroyed: false,
        id,
        isDestroyed() { return this.destroyed },
        close: vi.fn(function (this: StubWebContents) { this.destroyed = true }),
        loadFile: vi.fn(() => Promise.resolve()),
        loadURL: vi.fn(() => Promise.resolve()),
        on: vi.fn(),
        once: vi.fn(),
        setWindowOpenHandler: vi.fn(),
      }
      h.constructed.push(this)
    }
  }
  return {
    WebContentsView,
    webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
    ipcMain: { on: vi.fn(), removeListener: vi.fn() },
    shell: { openExternal: vi.fn() },
    session: {
      defaultSession: {
        registerPreloadScript: h.registerPreloadScript,
        unregisterPreloadScript: h.unregisterPreloadScript,
      },
      fromPartition: vi.fn(() => ({
        protocol: { handle: vi.fn(), isProtocolHandled: vi.fn(() => false) },
        webRequest: { onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() },
        registerPreloadScript: vi.fn(() => 'stub-partition-preload-id'),
        unregisterPreloadScript: vi.fn(),
      })),
    },
  }
})

vi.mock('../../utils/paths.js', () => ({
  mainPreloadPath: '/stub/preload.js',
  hostToolbarPreloadPath: STUB_LEGACY_ADVERTISER_PRELOAD,
  // R1 contract: the session-registered toolbar-runtime preload bundle,
  // resolved by the paths layer (so packaged/ASAR installs resolve correctly).
  hostToolbarRuntimePreloadPath: STUB_RUNTIME_PRELOAD,
  cjsSiblingPreloadPath: (p: string) => p,
  devtoolsPackageRoot: '/stub/devtools-pkg-root',
}))

function makeContext() {
  const addChildView = vi.fn()
  const removeChildView = vi.fn()
  const contentView = { addChildView, removeChildView, children: [] }
  const mainWindow = {
    destroyed: false,
    contentView,
    isDestroyed() { return this.destroyed },
    getContentSize: () => [1280, 980],
  }
  const notify = {
    popoverInit: vi.fn(),
    popoverClosed: vi.fn(),
    hostToolbarHeightChanged: vi.fn(),
  }
  return {
    notify,
    ctx: {
      windows: {
        mainWindow: mainWindow as unknown as import('electron').BrowserWindow,
      } as import('../window-service.js').WindowService,
      rendererDir: '/stub/renderer',
      notify: notify as unknown as import('../notifications/renderer-notifier.js').RendererNotifier,
      connections: createConnectionRegistry(),
    },
  }
}

/**
 * Re-import view-manager fresh: the session-registration ref-count is module
 * state, so per-test module isolation keeps the register/unregister call
 * counts meaningful per scenario.
 */
async function loadCreateViewManager() {
  const mod = await import('./view-manager.js')
  return mod.createViewManager
}

function toolbarView(index = 0): StubView {
  const view = h.constructed[index] as StubView | undefined
  if (!view) throw new Error(`no WebContentsView constructed at index ${index}`)
  return view
}

/** Loose handle for the not-yet-implemented setHeightMode surface (A.4). */
type HeightMode = 'auto' | { fixed: number }
type HostToolbarWithHeightMode = {
  setHeightMode: (mode: HeightMode) => void
}
function heightModeSurface(mgr: { hostToolbar: unknown }): HostToolbarWithHeightMode {
  return mgr.hostToolbar as HostToolbarWithHeightMode
}

beforeEach(() => {
  vi.resetModules()
  h.constructed.length = 0
  h.registerPreloadScript.mockClear()
  h.unregisterPreloadScript.mockClear()
})

// ── A.1 marker + defaultSession ──────────────────────────────────────────────

describe('R1/A.1 — toolbar WCV creation: marker + defaultSession', () => {
  it(`injects '${MARKER}' into webPreferences.additionalArguments`, async () => {
    // BUG CAUGHT: without the marker, the session-resident runtime's guard
    // (`process.argv.includes(marker)`) never matches in the toolbar window →
    // the advertiser never installs → the strip height stays 0 forever.
    const createViewManager = await loadCreateViewManager()
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    await mgr.hostToolbar.loadURL('https://x.test')

    const wp = toolbarView().webPreferences
    expect(wp, 'toolbar WCV must be constructed with webPreferences').toBeTruthy()
    const additionalArguments = wp!.additionalArguments as string[] | undefined
    expect(
      additionalArguments,
      'webPreferences.additionalArguments must exist on the toolbar WCV',
    ).toBeTruthy()
    expect(additionalArguments).toContain(MARKER)
  })

  it('does NOT set a partition or session — the toolbar stays on defaultSession', async () => {
    // BUG CAUGHT (guard, green today): moving the toolbar WCV onto its own
    // partition would silently detach it from the runtime preload registered
    // on session.defaultSession — height advertising dies with no error.
    const createViewManager = await loadCreateViewManager()
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    await mgr.hostToolbar.loadURL('https://x.test')

    const wp = toolbarView().webPreferences ?? {}
    expect(wp.partition, 'no partition: toolbar must live on defaultSession').toBeUndefined()
    expect(wp.session, 'no session override: toolbar must live on defaultSession').toBeUndefined()
  })
})

// ── A.2 session registration + ref-count ─────────────────────────────────────

describe('R1/A.2 — runtime preload registered on defaultSession (once, ref-counted)', () => {
  it('registers on FIRST toolbar need, with type:frame and the paths-layer absolute filePath, BEFORE the first load', async () => {
    // BUG CAUGHT: (a) registering eagerly at createViewManager time would tax
    // every host that never uses the toolbar; (b) registering with a relative
    // or hand-joined path breaks under ASAR; (c) registering AFTER loadURL
    // means the first load runs without the advertiser until a reload.
    const createViewManager = await loadCreateViewManager()
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    expect(
      h.registerPreloadScript,
      'no toolbar need yet — nothing should be registered at createViewManager time',
    ).not.toHaveBeenCalled()

    await mgr.hostToolbar.loadURL('https://x.test')

    expect(h.registerPreloadScript).toHaveBeenCalledTimes(1)
    const script = h.registerPreloadScript.mock.calls[0]![0]
    expect(script).toMatchObject({ type: 'frame', filePath: STUB_RUNTIME_PRELOAD })
    expect(path.isAbsolute(String(script.filePath))).toBe(true)

    // Ordering: registration must precede the first toolbar load.
    const registerOrder = h.registerPreloadScript.mock.invocationCallOrder[0]!
    const loadOrder = toolbarView().webContents.loadURL.mock.invocationCallOrder[0]!
    expect(
      registerOrder,
      'registerPreloadScript must run before the first toolbar load (or the first page misses the runtime)',
    ).toBeLessThan(loadOrder)
  })

  it('repeated toolbar use on the SAME manager does not re-register (exactly once per session)', async () => {
    // BUG CAUGHT: re-registering per ensure() stacks N copies of the runtime
    // preload on the session — the advertiser then installs N times per load.
    const createViewManager = await loadCreateViewManager()
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    await mgr.hostToolbar.loadURL('https://a.test')
    await mgr.hostToolbar.loadFile('/abs/toolbar.html')
    hostToolbarBounds(mgr,{ x: 0, y: 0, width: 1280, height: 48 })

    expect(h.registerPreloadScript).toHaveBeenCalledTimes(1)
  })

  it('two coexisting ViewManagers share ONE session registration', async () => {
    // BUG CAUGHT: same stacking bug as above, across contexts — two
    // ViewManagers in one process (workbench + a second window/context) must
    // not each pile a registration onto the shared defaultSession.
    const createViewManager = await loadCreateViewManager()
    const a = createViewManager(makeContext().ctx)
    const b = createViewManager(makeContext().ctx)

    await a.hostToolbar.loadURL('https://a.test')
    await b.hostToolbar.loadURL('https://b.test')

    expect(h.registerPreloadScript).toHaveBeenCalledTimes(1)
  })

  it('disposing ONE of two contexts does NOT unregister; the LAST disposeAll unregisters with the registration id', async () => {
    // A naive "disposeAll always unregisters" kills the OTHER still-alive
    // context's toolbar advertiser — its next
    // toolbar load silently has no height loop.
    const createViewManager = await loadCreateViewManager()
    const a = createViewManager(makeContext().ctx)
    const b = createViewManager(makeContext().ctx)
    await a.hostToolbar.loadURL('https://a.test')
    await b.hostToolbar.loadURL('https://b.test')

    a.disposeAll()
    expect(
      h.unregisterPreloadScript,
      'context B still alive — the shared session registration must survive A.disposeAll',
    ).not.toHaveBeenCalled()

    b.disposeAll()
    expect(h.unregisterPreloadScript).toHaveBeenCalledTimes(1)
    // Spike RESULTS.md: registerPreloadScript returns the id usable for
    // unregisterPreloadScript — the unregister must use exactly that id.
    expect(h.unregisterPreloadScript).toHaveBeenCalledWith('stub-preload-script-id')
  })

  it('a context that NEVER used the toolbar does not unregister on disposeAll', async () => {
    // BUG CAUGHT: decrementing a ref it never acquired drives the count to
    // zero early — the toolbar-using context loses its session runtime.
    const createViewManager = await loadCreateViewManager()
    const user = createViewManager(makeContext().ctx)
    const bystander = createViewManager(makeContext().ctx)
    await user.hostToolbar.loadURL('https://a.test')
    expect(h.registerPreloadScript).toHaveBeenCalledTimes(1)

    bystander.disposeAll()

    expect(h.unregisterPreloadScript).not.toHaveBeenCalled()
  })

  it('after the last release, a NEW context re-registers (no register-once-ever latch)', async () => {
    // BUG CAUGHT: a "registered = true" latch that survives the unregister
    // leaves every later context without the runtime — relaunch-style flows
    // (dispose everything, boot a fresh context) lose the toolbar height loop.
    const createViewManager = await loadCreateViewManager()
    const first = createViewManager(makeContext().ctx)
    await first.hostToolbar.loadURL('https://a.test')
    first.disposeAll()
    expect(h.unregisterPreloadScript).toHaveBeenCalledTimes(1)

    const second = createViewManager(makeContext().ctx)
    await second.hostToolbar.loadURL('https://b.test')

    expect(h.registerPreloadScript).toHaveBeenCalledTimes(2)
  })
})

// ── A.3 setPreloadPath semantics ─────────────────────────────────────────────

describe('R1/A.3 — setPreloadPath: host preload only, never the framework runtime', () => {
  it('a host-supplied preload does NOT lose the framework runtime (marker still injected, session registration still made)', async () => {
    // THE R1 INCIDENT, as a unit test: today setPreloadPath(custom) replaces
    // the advertiser preload wholesale and the strip height collapses to 0.
    // Under R1 the runtime is session-resident, so the host preload and the
    // framework runtime must coexist.
    const createViewManager = await loadCreateViewManager()
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.hostToolbar.setPreloadPath('/host/custom-preload.cjs')
    await mgr.hostToolbar.loadFile('/host/toolbar.html')

    const wp = toolbarView().webPreferences ?? {}
    expect(wp.preload, 'the host owns webPreferences.preload').toBe('/host/custom-preload.cjs')
    expect(
      (wp.additionalArguments as string[] | undefined) ?? [],
      'host preload must not strip the runtime marker',
    ).toContain(MARKER)
    expect(
      h.registerPreloadScript,
      'host preload must not skip the session runtime registration',
    ).toHaveBeenCalledTimes(1)
  })

  it('default creation (no setPreloadPath): webPreferences.preload is undefined — the advertiser no longer rides webPreferences', async () => {
    // BUG CAUGHT: leaving the old advertiser bundle in webPreferences.preload
    // makes it execute TWICE per load (session copy + webPreferences copy) —
    // two ResizeObservers double-publishing heights.
    const createViewManager = await loadCreateViewManager()
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    await mgr.hostToolbar.loadURL('https://x.test')

    const wp = toolbarView().webPreferences ?? {}
    expect(wp.preload).toBeUndefined()
  })

  it('setPreloadPath(null) = NO host preload (it does not "restore" the legacy advertiser preload)', async () => {
    // BUG CAUGHT: the old null semantics ("restore built-in advertiser")
    // resurrect the webPreferences advertiser copy → double execution again.
    // Exercises the documented rebuild path: custom → close wc → null → reload.
    const createViewManager = await loadCreateViewManager()
    const { ctx } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.hostToolbar.setPreloadPath('/host/custom-preload.cjs')
    await mgr.hostToolbar.loadFile('/host/toolbar.html')
    // Host tears its toolbar down; the next ensure() rebuilds the view.
    ;(toolbarView(0).webContents.close as unknown as () => void)()

    mgr.hostToolbar.setPreloadPath(null)
    await mgr.hostToolbar.loadFile('/host/toolbar2.html')

    expect(h.constructed.length).toBe(2)
    const wp = toolbarView(1).webPreferences ?? {}
    expect(wp.preload, 'null means "no host preload", not the legacy advertiser bundle').toBeUndefined()
    expect(
      (wp.additionalArguments as string[] | undefined) ?? [],
      'the rebuilt view still carries the runtime marker',
    ).toContain(MARKER)
  })
})

// ── A.4 setHeightMode ────────────────────────────────────────────────────────

describe('R1/A.4 — HostToolbarControl.setHeightMode', () => {
  it('exposes setHeightMode on the hostToolbar control surface', async () => {
    const createViewManager = await loadCreateViewManager()
    const mgr = createViewManager(makeContext().ctx)
    expect(typeof heightModeSurface(mgr).setHeightMode).toBe('function')
  })

  it("default mode is 'auto': advertiser reports forward unchanged (zero behaviour change)", async () => {
    // Guard (green today): R1 must not change the default path — the
    // advertiser keeps driving the placeholder height.
    const createViewManager = await loadCreateViewManager()
    const { ctx, notify } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.setHostToolbarHeight(48)

    expect(notify.hostToolbarHeightChanged).toHaveBeenCalledTimes(1)
    expect(notify.hostToolbarHeightChanged).toHaveBeenCalledWith(48)
  })

  it('fixed mode notifies the fixed height immediately', async () => {
    // BUG CAUGHT: a fixed mode that waits for the next advertiser report
    // leaves a host with a preload-less/static toolbar at height 0 forever
    // (nothing ever reports).
    const createViewManager = await loadCreateViewManager()
    const { ctx, notify } = makeContext()
    const mgr = createViewManager(ctx)

    heightModeSurface(mgr).setHeightMode({ fixed: 56 })

    expect(notify.hostToolbarHeightChanged).toHaveBeenCalledTimes(1)
    expect(notify.hostToolbarHeightChanged).toHaveBeenCalledWith(56)
  })

  it('fixed mode IGNORES subsequent advertiser reports', async () => {
    // BUG CAUGHT: if advertiser reports still pass through, the session-
    // resident advertiser (always installed now) fights the host's pinned
    // height — the strip oscillates 56↔64 on every content resize.
    const createViewManager = await loadCreateViewManager()
    const { ctx, notify } = makeContext()
    const mgr = createViewManager(ctx)

    heightModeSurface(mgr).setHeightMode({ fixed: 56 })
    notify.hostToolbarHeightChanged.mockClear()

    mgr.setHostToolbarHeight(64)

    expect(
      notify.hostToolbarHeightChanged,
      'advertiser reports must not reach the renderer while a fixed height is pinned',
    ).not.toHaveBeenCalled()
  })

  it("switching back to 'auto' does not synthesize a notify; the NEXT advertiser report drives again", async () => {
    // BUG CAUGHT both ways: (a) auto-switch replaying a stale cached height
    // would flash the old size; (b) auto-switch that never re-enables
    // forwarding leaves the toolbar pinned forever.
    const createViewManager = await loadCreateViewManager()
    const { ctx, notify } = makeContext()
    const mgr = createViewManager(ctx)

    heightModeSurface(mgr).setHeightMode({ fixed: 56 })
    notify.hostToolbarHeightChanged.mockClear()

    heightModeSurface(mgr).setHeightMode('auto')
    expect(
      notify.hostToolbarHeightChanged,
      "switching to 'auto' takes effect on the NEXT report, not retroactively",
    ).not.toHaveBeenCalled()

    mgr.setHostToolbarHeight(72)
    expect(notify.hostToolbarHeightChanged).toHaveBeenCalledTimes(1)
    expect(notify.hostToolbarHeightChanged).toHaveBeenCalledWith(72)
  })
})

// ── A.2 paths layer (real module) ────────────────────────────────────────────

describe('R1/A.2 — real paths layer exports the runtime preload path', () => {
  it('hostToolbarRuntimePreloadPath is an absolute .cjs path inside the package', async () => {
    // BUG CAUGHT: (a) export missing → view-manager has nothing ASAR-safe to
    // register; (b) a `.js` bundle would be loaded as ESM-in-CJS by the
    // session preload loader and crash with `require is not defined` (same
    // rule cjsSiblingPreloadPath exists for).
    const actual = await vi.importActual<Record<string, unknown>>('../../utils/paths.js')
    const p = actual.hostToolbarRuntimePreloadPath
    expect(typeof p, 'paths.ts must export hostToolbarRuntimePreloadPath').toBe('string')
    expect(path.isAbsolute(p as string)).toBe(true)
    expect((p as string).endsWith('.cjs'), `session preloads load as CJS — got ${String(p)}`).toBe(true)
    expect(p as string).toContain(actual.devtoolsPackageRoot as string)
  })
})
