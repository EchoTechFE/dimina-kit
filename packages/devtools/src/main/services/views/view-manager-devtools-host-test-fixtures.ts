/**
 * Shared harness for the simulator-DevTools host suites
 * (`view-manager-devtools-host-repoint.test.ts` +
 * `view-manager-service-host-ready.test.ts`), split out so each test file
 * stays under the repo's 500-line-per-file ratchet. Pure test scaffolding,
 * not code under test — same pattern as
 * network-forward/global-mirror-test-fixtures.ts.
 *
 * Consumers register the module mocks themselves (vi.mock factories are
 * hoisted per test file, so they live there, thin):
 *   vi.mock('electron', async () =>
 *     (await import('./view-manager-devtools-host-test-fixtures.js')).electronModuleMock())
 *   vi.mock('../../utils/paths.js', async () =>
 *     (await import('./view-manager-devtools-host-test-fixtures.js')).pathsModuleMock())
 * The electron factory closes over this module's `constructed` /
 * `serviceWcRegistry` registries, so test assertions and the mock see the
 * same objects (vitest gives each test FILE its own instance of this module —
 * no cross-file bleed).
 */
import { vi } from 'vitest'
import type { RenderEvent, ServiceHostReadyEvent } from '../../ipc/bridge-router.js'
import type { ViewManagerContext } from './view-manager.js'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'

export type StubWebContents = {
  destroyed: boolean
  id: number
  isDestroyed: () => boolean
  close: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  setZoomFactor: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  setMaxListeners: ReturnType<typeof vi.fn>
  getMaxListeners: ReturnType<typeof vi.fn>
  isLoading: ReturnType<typeof vi.fn>
  executeJavaScript: ReturnType<typeof vi.fn>
  setDevToolsWebContents: ReturnType<typeof vi.fn>
  openDevTools: ReturnType<typeof vi.fn>
  isDevToolsOpened: ReturnType<typeof vi.fn>
  closeDevTools: ReturnType<typeof vi.fn>
  getURL: ReturnType<typeof vi.fn>
}
export type StubView = {
  webContents: StubWebContents
  setBounds: ReturnType<typeof vi.fn>
  setBackgroundColor: ReturnType<typeof vi.fn>
}

/** Every WebContentsView ever constructed by the code under test, in
 * construction order: attachNativeSimulator builds [0] = the native simulator
 * content view, then attachNativeSimulatorDevtoolsHost builds [1] = the
 * DevTools front-end host view. Reset in each file's beforeEach. */
export const constructed: StubView[] = []

/** Service-host wcs registered by `makeServiceWc`, looked up by
 * `electron.webContents.fromId` — mirrors real Electron's global wc registry
 * so `onNativeServiceHostReady`'s `webContents.fromId(event.serviceWcId)`
 * resolution has something real to find. */
export const serviceWcRegistry = new Map<number, StubWebContents>()

/** One stub wc surface shared by BOTH stub flavors (the constructed
 * WebContentsView host wcs and the standalone service-host wcs) — a single
 * factory instead of two hand-maintained near-identical literals. */
function makeStubWc(id: number, overrides: Partial<StubWebContents> = {}): StubWebContents {
  return {
    destroyed: false,
    id,
    isDestroyed() { return this.destroyed },
    close: vi.fn(),
    loadURL: vi.fn(() => Promise.resolve()),
    loadFile: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setZoomFactor: vi.fn(),
    send: vi.fn(),
    setMaxListeners: vi.fn(),
    getMaxListeners: vi.fn(() => 10),
    // DevTools front-end host wc surface (the WebContentsView flavor is used
    // for `simulatorView.webContents`, i.e. the right-panel DevTools host).
    isLoading: vi.fn(() => false),
    executeJavaScript: vi.fn(() => Promise.resolve()),
    setDevToolsWebContents: vi.fn(),
    openDevTools: vi.fn(),
    isDevToolsOpened: vi.fn(() => false),
    closeDevTools: vi.fn(),
    getURL: vi.fn(() => ''),
    ...overrides,
  }
}

/** The `electron` module surface view-manager and its injectors touch. */
export function electronModuleMock(): Record<string, unknown> {
  let nextId = 1
  class WebContentsView {
    webContents: StubWebContents
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
    constructor(_opts?: unknown) {
      this.webContents = makeStubWc(nextId++, {
        close: vi.fn(function (this: StubWebContents) { this.destroyed = true }),
      })
      constructed.push(this as unknown as StubView)
    }
  }
  const ipcMain = {
    on: vi.fn(),
    removeListener: vi.fn(),
    handle: vi.fn(),
    removeHandler: vi.fn(),
  }
  return {
    WebContentsView,
    ipcMain,
    shell: { openExternal: vi.fn() },
    nativeTheme: { shouldUseDarkColors: false, on: vi.fn(), removeListener: vi.fn() },
    webContents: {
      fromId: vi.fn((id: number) => serviceWcRegistry.get(id)),
      getAllWebContents: vi.fn(() => []),
    },
    default: { ipcMain },
  }
}

export function pathsModuleMock(): Record<string, unknown> {
  return {
    mainPreloadPath: '/stub/preload.js',
    hostToolbarPreloadPath: '/stub/host-toolbar-preload.js',
    cjsSiblingPreloadPath: (p: string) => p.replace(/\.js$/, '.cjs'),
    devtoolsPackageRoot: '/stub/devtools-pkg-root',
  }
}

export const SIM_URL = 'http://localhost:7788/simulator.html?appId=repoint'

/** A hidden SERVICE-HOST BrowserWindow wc (top-level, can host DevTools). */
export function makeServiceWc(id: number): StubWebContents {
  const wc = makeStubWc(id, { isDevToolsOpened: vi.fn(() => true) })
  serviceWcRegistry.set(id, wc)
  return wc
}

// Explicit return annotation: a bare inferred type would name @vitest/spy's
// Mock type through a non-portable .pnpm path (TS2742) — the same pitfall
// this repo hit before with exported vi.fn()-bearing factories.
export interface DevtoolsHostHarness {
  addChildView: ReturnType<typeof vi.fn>
  removeChildView: ReturnType<typeof vi.fn>
  setActiveServiceWc: (wc: StubWebContents) => void
  emitRenderEvent: (event: RenderEvent) => void
  emitServiceHostReady: (event: ServiceHostReadyEvent) => void
  ctx: ViewManagerContext
}

export function makeContext(): DevtoolsHostHarness {
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

  // ── ctx.bridge stub ───────────────────────────────────────────────────────
  // Minimal `BridgeRouterHandle`: `getServiceWc` resolves to whatever the test
  // currently points `currentServiceWc` at (simulating a pre-warm-pool swap
  // between render events), and `onRenderEvent` fans a manually-driven
  // `RenderEvent` out to every subscriber (view-manager's own follow-path AND
  // elements-forward's internal subscription both register here).
  let currentServiceWc: StubWebContents | null = null
  const renderEventListeners = new Set<(event: RenderEvent) => void>()
  const serviceHostReadyListeners = new Set<(event: ServiceHostReadyEvent) => void>()
  const bridge = {
    isNativeHost: () => true,
    resolveRenderWc: () => null,
    getServiceWc: vi.fn(() => currentServiceWc),
    getServiceWcForBridge: () => null,
    getActiveRenderWc: () => null,
    getActiveBridgeId: () => null,
    onRenderEvent: (listener: (event: RenderEvent) => void) => {
      renderEventListeners.add(listener)
      return () => renderEventListeners.delete(listener)
    },
    onServiceHostReady: (listener: (event: ServiceHostReadyEvent) => void) => {
      serviceHostReadyListeners.add(listener)
      return () => serviceHostReadyListeners.delete(listener)
    },
    getDevice: () => null,
    setDevice: () => {},
    disposeSessionsForSimulator: () => Promise.resolve(),
  }

  function setActiveServiceWc(wc: StubWebContents): void {
    currentServiceWc = wc
  }
  function emitRenderEvent(event: RenderEvent): void {
    for (const l of [...renderEventListeners]) l(event)
  }
  function emitServiceHostReady(event: ServiceHostReadyEvent): void {
    for (const l of [...serviceHostReadyListeners]) l(event)
  }

  return {
    addChildView,
    removeChildView,
    setActiveServiceWc,
    emitRenderEvent,
    emitServiceHostReady,
    ctx: {
      windows: {
        mainWindow: mainWindow as unknown as import('electron').BrowserWindow,
      } as import('../window-service.js').WindowService,
      rendererDir: '/stub/renderer',
      notify: notify as unknown as import('../notifications/renderer-notifier.js').RendererNotifier,
      connections: createConnectionRegistry(),
      preloadPath: '/stub/sim-preload.js',
      bridge: bridge as unknown as ViewManagerContext['bridge'],
    },
  }
}
