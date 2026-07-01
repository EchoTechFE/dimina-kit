/**
 * Dead IPC channel decommission — wire-level contract.
 *
 * A sweep confirmed these channels have NO remaining consumers (the renderer
 * call sites are deleted in the same change), so the registrars must stop
 * registering them:
 *
 *   simulatorModule      — 'workbench:runtime:native-host', 'panel:list',
 *     (panel cluster)      'panel:select', 'panel:selectSimulator'
 *   registerSimulatorIpc — 'simulator:custom-apis:list', 'simulator:resize',
 *                          'simulator:setVisible'
 *   registerAppIpc       — 'app:getPreloadPath'
 *   registerSettingsIpc  — 'workbenchSettings:setVisible'
 *
 * Real bug each "not registered" test catches: a leftover `.handle(...)` /
 * `.on(...)` keeps the dead channel alive at the wire level — any stale
 * renderer code (or a downstream host's renderer fork) could keep driving a
 * path main no longer maintains (e.g. `panel:select` calling into the
 * deleted static show/hide route). Wire names are asserted as STRING
 * LITERALS (not via the enum) so:
 *   1. the test still compiles after the enum entry is deleted;
 *   2. re-registering the same wire name under a new constant is also caught;
 *   3. deleting the enum entry but keeping a literal-string registration is
 *      caught too.
 * Both `ipcMain.handle` AND `ipcMain.on` registrations are checked, so a
 * "removed the handle(), re-added it as on()" half-removal can't slip by.
 *
 * Each registrar block carries at least one "still registered" sanity anchor
 * so "channel absent" provably comes from targeted removal, not from the
 * registrar failing to register anything at all (whole-suite false green).
 *
 * Survivor pins (explicitly NOT to be removed):
 *   - 'simulator:custom-apis:invoke' — e2e drives it.
 *   - 'settings:setVisible' (SettingsChannel.SetVisible) — the settings
 *     overlay cluster is a separate decision; only the WORKBENCH-settings
 *     'workbenchSettings:setVisible' goes away.
 *
 * Guards that none of panels.ts, simulator.ts, app.ts, or settings.ts
 * register the dead channels.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── electron stub: capture ipcMain.handle AND ipcMain.on by channel ─────────
const stub = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown
  const handled = new Map<string, Handler>()
  const listened = new Map<string, Handler>()
  return {
    handled,
    listened,
    /** True when the channel is reachable on the wire by EITHER mechanism. */
    registered(channel: string): boolean {
      return handled.has(channel) || listened.has(channel)
    },
    ipcMain: {
      handle: vi.fn((channel: string, fn: Handler) => {
        handled.set(channel, fn)
      }),
      removeHandler: vi.fn((channel: string) => {
        handled.delete(channel)
      }),
      on: vi.fn((channel: string, fn: Handler) => {
        listened.set(channel, fn)
      }),
      removeListener: vi.fn((channel: string) => {
        listened.delete(channel)
      }),
      removeAllListeners: vi.fn((channel: string) => {
        listened.delete(channel)
      }),
    },
  }
})

vi.mock('electron', () => ({
  ipcMain: stub.ipcMain,
  app: {
    isPackaged: false,
    commandLine: { getSwitchValue: vi.fn(() => '') },
  },
  default: { ipcMain: stub.ipcMain },
}))

// Heavyweight sibling registrar inside simulatorModule (dmb:* channels, CDP
// wiring) — out of scope for the dead-channel assertions; stub it so the
// module-level seam below stays hermetic.
vi.mock('./bridge-router.js', () => ({
  installBridgeRouter: vi.fn(),
}))

// registerSettingsIpc imports these at module level; keep the test hermetic
// (no real settings file IO / window opening / MCP probing).
vi.mock('../app/launch.js', () => ({
  openSettingsWindow: vi.fn(),
}))
vi.mock('../services/settings/index.js', () => ({
  loadWorkbenchSettings: vi.fn(() => ({
    theme: 'system',
    cdp: { enabled: false, port: 0 },
    mcp: { enabled: false, port: 0 },
  })),
  saveWorkbenchSettings: vi.fn(),
  applyTheme: vi.fn(),
}))
vi.mock('../services/mcp/status.js', () => ({
  getMcpStatus: vi.fn(() => ({ running: false, port: null, error: null })),
}))

type Disposable = { dispose: () => unknown }

beforeEach(() => {
  stub.handled.clear()
  stub.listened.clear()
  stub.ipcMain.handle.mockClear()
  stub.ipcMain.on.mockClear()
  vi.resetModules()
})

// ── panel cluster (via simulatorModule) ──────────────────────────────────────
//
// The panels registrar registers nothing (panel:eval is decommissioned; see
// simulator-module-toolbar-eval-decommission.test.ts), so this block cannot
// anchor on a panels channel. The seam is `simulatorModule.setup` (which fans
// out into the same registrars), and the sanity anchor is
// 'simulator:attach-native' — registered by registerSimulatorIpc inside the
// same module, so "channel absent" still provably comes from targeted removal,
// not from the module wiring nothing.

async function setupSimulatorModule(): Promise<Disposable> {
  const { simulatorModule } = await import('./simulator-module.js')
  return simulatorModule.setup({
    views: {
      attachNativeSimulator: vi.fn(),
      detachSimulator: vi.fn(),
      setNativeSimulatorViewBounds: vi.fn(),
      reapplySafeArea: vi.fn(),
      setSimulatorDevtoolsBounds: vi.fn(),
      setHostToolbarBounds: vi.fn(),
      getHostToolbarWebContentsId: vi.fn(() => -1),
      setHostToolbarHeight: vi.fn(),
      getSimulatorWebContents: vi.fn(() => null),
    } as never,
    notify: {} as never,
    senderPolicy: undefined,
    simulatorApis: { list: vi.fn(() => []), invoke: vi.fn() } as never,
    toolbar: { list: vi.fn(() => []), getHandler: vi.fn(() => undefined) } as never,
    workspace: { hasActiveSession: vi.fn(() => false) } as never,
    bridge: undefined,
  } as never) as Disposable
}

describe('simulatorModule (panel cluster): dead channels are gone', () => {
  it("no longer registers 'workbench:runtime:native-host' (contract A1)", async () => {
    const d = await setupSimulatorModule()
    expect(
      stub.registered('workbench:runtime:native-host'),
      'native-host is the sole runtime — a live GetNativeHost handler keeps a dead renderer branch point answerable',
    ).toBe(false)
    await d.dispose()
  })

  it("no longer registers 'panel:list' (contract A2 — renderer listPanels() is deleted)", async () => {
    const d = await setupSimulatorModule()
    expect(
      stub.registered('panel:list'),
      'panel:list has no consumer once renderer listPanels() is deleted; a leftover handler is dead wire surface',
    ).toBe(false)
    await d.dispose()
  })

  it("no longer registers 'panel:select' (contract B2 — visibility converges on the anchor 0×0 single path)", async () => {
    const d = await setupSimulatorModule()
    expect(
      stub.registered('panel:select'),
      'panel:select drove the legacy hideSimulator() show/hide side-channel; visibility is anchor-published bounds only',
    ).toBe(false)
    await d.dispose()
  })

  it("no longer registers 'panel:selectSimulator' (contract B2)", async () => {
    const d = await setupSimulatorModule()
    expect(
      stub.registered('panel:selectSimulator'),
      'panel:selectSimulator drove the legacy showSimulator(simWidth) path; visibility is anchor-published bounds only',
    ).toBe(false)
    await d.dispose()
  })

  it("sanity anchor: 'simulator:attach-native' is still registered (module did not go empty)", async () => {
    const d = await setupSimulatorModule()
    // Guards against "tests above pass because simulatorModule registers
    // nothing" — see block comment above.
    expect(stub.handled.has('simulator:attach-native')).toBe(true)
    await d.dispose()
  })
})

// ── registerSimulatorIpc ─────────────────────────────────────────────────────

async function setupSimulator(): Promise<Disposable> {
  const { registerSimulatorIpc } = await import('./simulator.js')
  return registerSimulatorIpc({
    views: {
      attachNativeSimulator: vi.fn(),
      detachSimulator: vi.fn(),
      setNativeSimulatorViewBounds: vi.fn(),
      reapplySafeArea: vi.fn(),
    } as never,
    notify: {} as never,
    senderPolicy: undefined,
    simulatorApis: { list: vi.fn(() => []), invoke: vi.fn() } as never,
    bridge: undefined,
  } as never) as Disposable
}

describe('registerSimulatorIpc: dead channels are gone', () => {
  it("no longer registers 'simulator:custom-apis:list' (contract A3)", async () => {
    const d = await setupSimulator()
    expect(
      stub.registered('simulator:custom-apis:list'),
      'custom-apis:list has no consumer (the simulator guest reaches the registry via the bridge channels, never this main-window handle)',
    ).toBe(false)
    await d.dispose()
  })

  it("no longer registers 'simulator:resize' (contract B2)", async () => {
    const d = await setupSimulator()
    expect(
      stub.registered('simulator:resize'),
      'simulator:resize fed views.resize() → computeSimulatorBounds static layout; bounds are anchor-published only',
    ).toBe(false)
    await d.dispose()
  })

  it("no longer registers 'simulator:setVisible' (contract B2)", async () => {
    const d = await setupSimulator()
    expect(
      stub.registered('simulator:setVisible'),
      'simulator:setVisible fed views.setVisible() show/hide; visibility is the anchor 0×0 single path',
    ).toBe(false)
    await d.dispose()
  })

  it("no longer registers 'simulator:set-native-bounds' (superseded by the window-level placement snapshot)", async () => {
    const d = await setupSimulator()
    expect(
      stub.registered('simulator:set-native-bounds'),
      'per-view native-simulator bounds are gone; the renderer publishes ONE window-level placement snapshot (view:placement-snapshot) reconciled in main',
    ).toBe(false)
    await d.dispose()
  })

  it("survivor pin: 'simulator:custom-apis:invoke' MUST stay registered (e2e drives it)", async () => {
    const d = await setupSimulator()
    // Catches over-deletion: removing the whole SimulatorCustomApiChannel
    // cluster instead of just List would break custom-api e2e + downstream hosts.
    expect(stub.handled.has('simulator:custom-apis:invoke')).toBe(true)
    await d.dispose()
  })

  it("sanity anchor: 'simulator:attach-native' is still registered", async () => {
    const d = await setupSimulator()
    // Guards against "registrar registers nothing" whole-suite false green.
    expect(stub.handled.has('simulator:attach-native')).toBe(true)
    await d.dispose()
  })
})

// ── registerAppIpc ───────────────────────────────────────────────────────────

async function setupApp(): Promise<Disposable> {
  const { registerAppIpc } = await import('./app.js')
  return registerAppIpc({
    preloadPath: '/tmp/preload.js',
    brandingProvider: undefined,
    appName: 'Test App',
    senderPolicy: undefined,
  } as never) as Disposable
}

describe('registerAppIpc: app:getPreloadPath is decommissioned', () => {
  it("no longer registers 'app:getPreloadPath' (contract A4 — the renderer dead pipe is deleted)", async () => {
    const d = await setupApp()
    expect(
      stub.registered('app:getPreloadPath'),
      'app:getPreloadPath fed use-session.ts:101 → use-project-runtime-controller.ts preloadPath, which no component consumes; a live handler keeps leaking the realpathed preload location to any renderer for nothing',
    ).toBe(false)
    await d.dispose()
  })

  it("sanity anchor: 'app:getBranding' is still registered", async () => {
    const d = await setupApp()
    // Guards against "registerAppIpc registers nothing" false green.
    expect(stub.handled.has('app:getBranding')).toBe(true)
    await d.dispose()
  })
})

// ── registerSettingsIpc ──────────────────────────────────────────────────────

async function setupSettings(): Promise<Disposable> {
  const { registerSettingsIpc } = await import('./settings.js')
  return registerSettingsIpc({
    views: {} as never,
    notify: {} as never,
    workspace: {} as never,
    rendererDir: '/tmp/renderer',
    senderPolicy: undefined,
    windows: { closeSettingsWindow: vi.fn() } as never,
  } as never) as Disposable
}

describe('registerSettingsIpc: workbenchSettings:setVisible is decommissioned', () => {
  it("no longer registers 'workbenchSettings:setVisible' (contract A6)", async () => {
    const d = await setupSettings()
    expect(
      stub.registered('workbenchSettings:setVisible'),
      'workbenchSettings:setVisible has no consumer; a live handler keeps an unreachable openSettingsWindow entry point on the wire',
    ).toBe(false)
    await d.dispose()
  })

  it("survivor pin: 'settings:setVisible' (SettingsChannel.SetVisible) MUST stay registered", async () => {
    const d = await setupSettings()
    // Catches over-deletion / name confusion: ONLY the workbenchSettings-
    // prefixed channel goes away. The embedded settings overlay channel is a
    // separate cluster pending its own decision and must not be collateral.
    expect(stub.handled.has('settings:setVisible')).toBe(true)
    await d.dispose()
  })

  it("sanity anchor: 'workbenchSettings:get' is still registered", async () => {
    const d = await setupSettings()
    expect(stub.handled.has('workbenchSettings:get')).toBe(true)
    await d.dispose()
  })
})
