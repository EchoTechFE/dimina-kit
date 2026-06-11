/**
 * Per-project session ISOLATION for the native-host runtime (P0 debt).
 *
 * Today every project's miniapp webContents — the simulator content
 * WebContentsView, its nested render-host `<webview>`s, AND the service-host
 * window — share ONE hard-coded `persist:simulator` Electron session. That
 * means cookies / localStorage / cache / IndexedDB written by project A are
 * visible to (and clobbered by) project B. Two projects open at once cross-
 * contaminate; "clear storage" on one nukes the other.
 *
 * These tests pin the BEHAVIOR a fix must produce — they do NOT prescribe the
 * exact helper, only the observable session-partition each webContents is
 * created on:
 *
 *   1. Two DIFFERENT projects → DIFFERENT partitions, each shaped
 *      `persist:miniapp-<stable-project-key>`. The SAME project re-opened →
 *      the SAME partition (so its cache/storage survives a relaunch).
 *   2. Within ONE project, every webContents (simulator view, its render-host
 *      guest, and the service host) → the SAME partition (intra-project storage
 *      stays shared, e.g. render and service see one localStorage).
 *   3. Tearing a project's session down (detach + close its webContents) leaves
 *      no dangling reference to the destroyed webContents and never throws.
 *
 * The project identity flows in already: the simulator URL carries `?appId=…`
 * (`shared/simulator-route.ts buildSimulatorUrl`/`parseRoute`) and the spawn
 * path has `appId` directly. The partition must be derived from that — NOT a
 * constant.
 *
 * RED until the isolation work lands: the implementation still pins the literal
 * `'persist:simulator'`, so every assertion that the partition is
 * project-derived (and that two projects differ) fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Electron mock ───────────────────────────────────────────────────────────
// A WebContentsView whose constructor RECORDS its webPreferences (so we can read
// back the `partition` each miniapp view is created on) and whose webContents is
// a real-ish emitter (so `will-attach-webview` listeners fire and we can observe
// the partition a nested render-host `<webview>` guest is pinned to).
type AnyFn = (...a: unknown[]) => unknown

interface StubWc {
  id: number
  destroyed: boolean
  isDestroyed: () => boolean
  close: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  on: (event: string, fn: AnyFn) => unknown
  once: (event: string, fn: AnyFn) => unknown
  emit: (event: string, ...a: unknown[]) => void
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  setZoomFactor: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  __listeners: Record<string, Set<AnyFn>>
}

interface StubView {
  webPreferences: Record<string, unknown> | undefined
  webContents: StubWc
  setBounds: ReturnType<typeof vi.fn>
  setBackgroundColor: ReturnType<typeof vi.fn>
}

const constructedViews: StubView[] = []
const ipcMainListeners = new Map<string, Set<AnyFn>>()

vi.mock('electron', () => {
  let nextId = 1
  function makeWc(): StubWc {
    const listeners: Record<string, Set<AnyFn>> = {}
    const wc: StubWc = {
      id: nextId++,
      destroyed: false,
      isDestroyed() { return this.destroyed },
      close: vi.fn(function (this: StubWc) { this.destroyed = true; this.emit('destroyed') }),
      loadURL: vi.fn(() => Promise.resolve()),
      on(event: string, fn: AnyFn) { (listeners[event] ??= new Set()).add(fn); return wc },
      once(event: string, fn: AnyFn) {
        const wrap: AnyFn = (...a: unknown[]) => { listeners[event]?.delete(wrap); return fn(...a) }
        ;(listeners[event] ??= new Set()).add(wrap); return wc
      },
      emit(event: string, ...a: unknown[]) { for (const fn of [...(listeners[event] ?? [])]) fn(...a) },
      setWindowOpenHandler: vi.fn(),
      setZoomFactor: vi.fn(),
      send: vi.fn(),
      __listeners: listeners,
    }
    return wc
  }

  class WebContentsView {
    webPreferences: Record<string, unknown> | undefined
    webContents: StubWc
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
    constructor(opts?: { webPreferences?: Record<string, unknown> }) {
      this.webPreferences = opts?.webPreferences
      this.webContents = makeWc()
      constructedViews.push(this as unknown as StubView)
    }
  }

  const ipcMain = {
    on(channel: string, fn: AnyFn) { (ipcMainListeners.get(channel) ?? ipcMainListeners.set(channel, new Set()).get(channel)!).add(fn) },
    removeListener(channel: string, fn: AnyFn) { ipcMainListeners.get(channel)?.delete(fn) },
    off(channel: string, fn: AnyFn) { ipcMainListeners.get(channel)?.delete(fn) },
  }

  // Minimal BrowserWindow so `constructServiceHostWindow` (the service-host
  // path) can build a window without a real Electron runtime — it only records
  // the webPreferences it was constructed with, like the WebContentsView stub.
  class BrowserWindow {
    webContents: StubWc
    webPreferences: Record<string, unknown> | undefined
    constructor(opts?: { webPreferences?: Record<string, unknown> }) {
      this.webPreferences = opts?.webPreferences
      this.webContents = makeWc()
    }
    loadURL = vi.fn(() => Promise.resolve())
    isDestroyed = () => false
    once = vi.fn()
  }

  return {
    WebContentsView,
    BrowserWindow,
    webContents: { fromId: (_id: number) => null },
    session: { fromPartition: (_p: string) => ({}) },
    ipcMain,
    shell: { openExternal: vi.fn() },
  }
})

vi.mock('../../utils/paths.js', () => ({
  mainPreloadPath: '/stub/preload.js',
  hostToolbarPreloadPath: '/stub/host-toolbar-preload.js',
  devtoolsPackageRoot: '/stub/devtools-pkg-root',
  // Native simulator hands the WCV the `.cjs` sibling; the partition logic is
  // independent of this, so an identity-ish stub is fine.
  cjsSiblingPreloadPath: (p: string) => p.replace(/\.js$/, '.cjs'),
}))

// Import AFTER the mocks so the SUT binds the stub electron + paths.
import { createViewManager, type ViewManagerContext } from './view-manager.js'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'
import { buildSimulatorUrl } from '../../../shared/simulator-route.js'
import {
  serviceHostSpec,
  constructServiceHostWindow,
} from '../../windows/service-host-window/create.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal compileConfig accepted by buildSimulatorUrl. */
const COMPILE = { startPage: 'pages/index/index', scene: 1001, queryParams: [] } as never

/** Build a native-simulator URL for a project (its appId is the project key). */
function simUrlFor(appId: string): string {
  return buildSimulatorUrl(appId, COMPILE, 5173)
}

function makeViewCtx(): ViewManagerContext {
  const contentView = { addChildView: vi.fn(), removeChildView: vi.fn(), children: [] }
  const mainWindow = {
    destroyed: false,
    contentView,
    isDestroyed() { return this.destroyed },
    getContentSize: () => [1280, 980],
  }
  return {
    windows: { mainWindow: mainWindow as unknown as Electron.BrowserWindow } as ViewManagerContext['windows'],
    rendererDir: '/stub/renderer',
    panels: ['console'],
    notify: { popoverInit: vi.fn(), popoverClosed: vi.fn() } as unknown as ViewManagerContext['notify'],
    connections: createConnectionRegistry(),
    // attachNativeSimulator needs a preload path to proceed past its guard.
    preloadPath: '/stub/simulator-preload.js',
    // Optional native-host collaborators — omitted (the partition derivation
    // must not depend on them).
  }
}

/**
 * The native simulator content WebContentsView the SUT just constructed.
 *
 * `attachNativeSimulator` builds the simulator WCV with explicit
 * `webPreferences` (where the miniapp partition lives) and ALSO builds a
 * partition-less DevTools-host WCV afterward; we want the FORMER. Pick the most
 * recently-constructed view that carries `webPreferences` (the simulator one);
 * a partition-less DevTools-host view has `webPreferences === undefined`.
 *
 * NOTE: if a future fix moves the partition out of the constructor opts onto a
 * `session.fromPartition()` call (no `webPreferences`), this helper returns the
 * wrong view — that's an intentional brittleness so the partition stays an
 * observable constructor-time fact. The contract under test is the partition
 * value, not where it is set; adjust the helper, not the assertions, if so.
 */
function latestView(): StubView {
  for (let i = constructedViews.length - 1; i >= 0; i--) {
    const v = constructedViews[i]!
    if (v.webPreferences) return v
  }
  const v = constructedViews[constructedViews.length - 1]
  if (!v) throw new Error('no WebContentsView constructed')
  return v
}

/** Fire a render-host guest attach and return the partition it was pinned to. */
function attachGuestPartition(simWc: StubWc): string | undefined {
  const webPreferences: Record<string, unknown> = {}
  const params: Record<string, unknown> = {}
  simWc.emit('will-attach-webview', {}, webPreferences, params)
  // The guest partition is whatever the handler stamped onto webPreferences
  // (and params); a fix that isolates per-project must stamp the SAME project
  // partition the host WCV uses, not the shared constant.
  return (webPreferences.partition ?? params.partition) as string | undefined
}

const APP_A = 'wxappAAAAAAAAAAA'
const APP_B = 'wxappBBBBBBBBBBB'

beforeEach(() => {
  constructedViews.length = 0
  ipcMainListeners.clear()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────────
// 1. Two projects → distinct, project-stable partitions
// ─────────────────────────────────────────────────────────────────────────────
describe('native simulator: per-project partition isolation', () => {
  it('two different projects mount their simulator WCV on DIFFERENT persist:miniapp-<key> partitions', () => {
    const mgrA = createViewManager(makeViewCtx())
    mgrA.attachNativeSimulator(simUrlFor(APP_A), 375)
    const partA = latestView().webPreferences?.partition as string | undefined

    const mgrB = createViewManager(makeViewCtx())
    mgrB.attachNativeSimulator(simUrlFor(APP_B), 375)
    const partB = latestView().webPreferences?.partition as string | undefined

    expect(partA).toMatch(/^persist:miniapp-/)
    expect(partB).toMatch(/^persist:miniapp-/)
    // The P0 bug: both currently come back as the literal 'persist:simulator'.
    expect(partA).not.toBe(partB)
  })

  it('re-opening the SAME project mounts on the SAME partition (cache/storage survives relaunch)', () => {
    const mgr1 = createViewManager(makeViewCtx())
    mgr1.attachNativeSimulator(simUrlFor(APP_A), 375)
    const first = latestView().webPreferences?.partition as string | undefined

    const mgr2 = createViewManager(makeViewCtx())
    mgr2.attachNativeSimulator(simUrlFor(APP_A), 375)
    const second = latestView().webPreferences?.partition as string | undefined

    expect(first).toMatch(/^persist:miniapp-/)
    expect(second).toBe(first)
  })

  it('is a persistent (persist:) partition so cache/cookies survive process restart', () => {
    const mgr = createViewManager(makeViewCtx())
    mgr.attachNativeSimulator(simUrlFor(APP_A), 375)
    const part = latestView().webPreferences?.partition as string | undefined
    expect(part).toBeTruthy()
    expect(part!.startsWith('persist:')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Within ONE project, all webContents share that project's partition
// ─────────────────────────────────────────────────────────────────────────────
describe('intra-project session sharing', () => {
  it('the nested render-host <webview> guest is pinned to the SAME partition as its simulator host WCV', () => {
    const mgr = createViewManager(makeViewCtx())
    mgr.attachNativeSimulator(simUrlFor(APP_A), 375)
    const view = latestView()
    const hostPartition = view.webPreferences?.partition as string | undefined

    const guestPartition = attachGuestPartition(view.webContents)

    expect(hostPartition).toMatch(/^persist:miniapp-/)
    // render + simulator-host must share storage within a project.
    expect(guestPartition).toBe(hostPartition)
  })

  it('the SERVICE-HOST window for a project uses that project\'s partition (so service & render share storage)', () => {
    // The service-host spec/window is the logic layer for the SAME project as
    // the simulator above. Its partition must match the project's miniapp
    // partition so localStorage/cookies are shared across the runtime, NOT a
    // global constant shared with every other project.
    const simMgr = createViewManager(makeViewCtx())
    simMgr.attachNativeSimulator(simUrlFor(APP_A), 375)
    const simPartition = latestView().webPreferences?.partition as string | undefined

    const spec = serviceHostSpec(APP_A)
    expect(spec.partition).toMatch(/^persist:miniapp-/)
    expect(spec.partition).toBe(simPartition)

    const win = constructServiceHostWindow({ appId: APP_A, partition: spec.partition })
    const wp = (win as unknown as { webContents: { __wp?: Record<string, unknown> } })
    // BrowserWindow webPreferences aren't readable post-construction in the real
    // API, so the spec (the value handed to the window) is the observable seam;
    // assert the window was constructed with it without throwing.
    expect(win).toBeDefined()
    void wp
  })

  it('two different projects get DIFFERENT service-host partitions (no cross-project storage)', () => {
    const a = serviceHostSpec(APP_A).partition
    const b = serviceHostSpec(APP_B).partition
    expect(a).toMatch(/^persist:miniapp-/)
    expect(b).toMatch(/^persist:miniapp-/)
    expect(a).not.toBe(b)
  })

  it('the same project yields a stable service-host partition across calls', () => {
    expect(serviceHostSpec(APP_A).partition).toBe(serviceHostSpec(APP_A).partition)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Teardown: no dangling session reference, no throw
// ─────────────────────────────────────────────────────────────────────────────
describe('session teardown', () => {
  it('detaching the native simulator closes its webContents and leaves no live simulator reference', () => {
    const mgr = createViewManager(makeViewCtx())
    mgr.attachNativeSimulator(simUrlFor(APP_A), 375)
    const view = latestView()
    const simWc = view.webContents

    expect(() => mgr.detachSimulator()).not.toThrow()

    // The project's webContents is actually torn down…
    expect(simWc.close).toHaveBeenCalled()
    expect(simWc.isDestroyed()).toBe(true)
    // …and the manager no longer hands back a destroyed simulator wc.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stale = (mgr as any).getSimulatorWebContents?.()
    expect(stale == null || stale.isDestroyed?.() !== false).toBeTruthy()
  })

  it('re-attaching a DIFFERENT project after teardown does not reuse the prior project partition', () => {
    const mgr = createViewManager(makeViewCtx())
    mgr.attachNativeSimulator(simUrlFor(APP_A), 375)
    const partA = latestView().webPreferences?.partition as string | undefined
    mgr.detachSimulator()

    mgr.attachNativeSimulator(simUrlFor(APP_B), 375)
    const partB = latestView().webPreferences?.partition as string | undefined

    expect(partA).toMatch(/^persist:miniapp-/)
    expect(partB).toMatch(/^persist:miniapp-/)
    expect(partB).not.toBe(partA)
  })

  it('tearing down twice (idempotent) never throws on the destroyed webContents', () => {
    const mgr = createViewManager(makeViewCtx())
    mgr.attachNativeSimulator(simUrlFor(APP_A), 375)
    expect(() => {
      mgr.detachSimulator()
      mgr.detachSimulator()
    }).not.toThrow()
  })
})
