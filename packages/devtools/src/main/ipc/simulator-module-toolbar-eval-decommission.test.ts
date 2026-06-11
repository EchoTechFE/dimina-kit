/**
 * Wave 2 decommission — wire-level contract for the 'simulator' built-in
 * module: the host-injected toolbar cluster and the panel:eval channel are
 * deleted.
 *
 *   toolbar cluster — 'toolbar:getActions', 'toolbar:invoke'
 *     The `instance.toolbar.set()` host-button mechanism is removed outright
 *     (user decision, breaking change). With no `instance.toolbar` there is
 *     no store to read and no handler table to invoke into.
 *   panel:eval — 'panel:eval'
 *     Arbitrary `executeJavaScript` into the simulator WCV, exposed to any
 *     trusted renderer. No renderer call site remains.
 *
 * Real bug each "not registered" test catches: a leftover `.handle(...)`
 * keeps the dead channel answerable at the wire level. For 'panel:eval' that
 * is an eval-into-the-simulator primitive any compromised-but-trusted sender
 * could keep driving; for the toolbar pair it keeps a renderer fetch path
 * alive that can silently resurrect the deleted host-actions row.
 *
 * Seam: `simulatorModule.setup(ctx)` — the module that fans out into the
 * individual registrars — NOT the per-registrar functions. Deliberate: the
 * implementer may delete `toolbar.ts` / `panels.ts` outright (after panel:eval
 * goes, registerPanelsIpc registers nothing), and a test importing a deleted
 * file breaks for the wrong reason. The module survives either shape and is
 * exactly where a half-removed registrar would still be wired up.
 *
 * Wire names are STRING LITERALS (not the enums) so the test still compiles
 * after `ToolbarChannel` / `PanelChannel` are deleted, and a re-registration
 * under a new constant is caught too. Both `ipcMain.handle` AND `ipcMain.on`
 * are checked so a "moved the handle() to on()" half-removal can't slip by.
 *
 * RED today: simulator-module.ts wires registerToolbarIpc (toolbar.ts:10/15)
 * and registerPanelsIpc (panels.ts:10) which register all three channels.
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

// The bridge router is a heavyweight sibling registrar inside the same module
// (dmb:* channels, CDP wiring). Out of scope here — stub it so the module can
// be driven hermetically. The file is NOT part of this decommission and stays.
vi.mock('./bridge-router.js', () => ({
  installBridgeRouter: vi.fn(),
}))

type Disposable = { dispose: () => unknown }

beforeEach(() => {
  stub.handled.clear()
  stub.listened.clear()
  stub.ipcMain.handle.mockClear()
  stub.ipcMain.on.mockClear()
  vi.resetModules()
})

/**
 * Minimal ctx superset for every registrar the module wires today. Extra keys
 * (`toolbar`, `workspace`) stay harmless once their consumers are deleted —
 * the stub must not need editing when the implementation lands.
 */
async function setupModule(): Promise<Disposable> {
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

describe('simulatorModule: host toolbar IPC cluster is decommissioned', () => {
  it("no longer registers 'toolbar:getActions'", async () => {
    const d = await setupModule()
    expect(
      stub.registered('toolbar:getActions'),
      'with instance.toolbar deleted there is no action store — a live GetActions handler lets stale renderer code resurrect the host-actions row from an always-empty (or worse, half-deleted) store',
    ).toBe(false)
    await d.dispose()
  })

  it("no longer registers 'toolbar:invoke'", async () => {
    const d = await setupModule()
    expect(
      stub.registered('toolbar:invoke'),
      'toolbar:invoke dispatched into host-registered handlers; with the registration surface gone a live handler is an unreachable-by-design invoke path kept answerable on the wire',
    ).toBe(false)
    await d.dispose()
  })
})

describe("simulatorModule: 'panel:eval' is decommissioned", () => {
  it("no longer registers 'panel:eval'", async () => {
    const d = await setupModule()
    expect(
      stub.registered('panel:eval'),
      'panel:eval is an arbitrary executeJavaScript-into-the-simulator primitive with zero renderer call sites — a leftover handler keeps that eval surface open to every trusted sender',
    ).toBe(false)
    await d.dispose()
  })
})

describe('simulatorModule: survivors (module did not go empty)', () => {
  it("sanity anchor: 'simulator:attach-native' is still registered", async () => {
    const d = await setupModule()
    // Guards against "tests above pass because simulatorModule.setup registers
    // nothing at all" (whole-suite false green).
    expect(stub.handled.has('simulator:attach-native')).toBe(true)
    await d.dispose()
  })

  it("survivor pin: 'simulator:custom-apis:invoke' MUST stay registered (custom API mechanism lives on)", async () => {
    const d = await setupModule()
    // The user decision deletes ONLY the toolbar cluster. registerSimulatorApi
    // / wx.<name>() custom APIs continue to be supported — e2e drives this
    // channel (extension-host.spec.ts e2eEcho). Catches over-deletion.
    expect(stub.handled.has('simulator:custom-apis:invoke')).toBe(true)
    await d.dispose()
  })
})
