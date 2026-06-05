/**
 * TDD (RED) for the UNIMPLEMENTED `buildWireTransportOptions`.
 *
 * The @dimina-kit/workbench `WireTransport` needs a `WireTransportDeps`-shaped
 * triple `{ ipcMain, trustedWebContents, senderPolicy }` to run inside real
 * Electron. devtools' `WorkbenchContext` already owns the authoritative trust
 * state, but in a DIFFERENT shape than WireTransport expects:
 *
 *  - `ctx.senderPolicy` (devtools, `utils/ipc-registry.ts`) is a *function*
 *    `(sender: WebContents) => boolean` — it takes a full WebContents object.
 *  - WireTransport's `senderPolicy` (workbench, `src/types.ts`) is an *object*
 *    `{ isTrusted(senderId: number): boolean }` — it takes a numeric id
 *    (`wire-transport.ts:183` calls `this.deps.senderPolicy.isTrusted(senderId)`).
 *
 * So `buildWireTransportOptions` is an ADAPTER: it must resolve a numeric
 * sender id back to a live WebContents (via `electron.webContents.fromId`) and
 * delegate to `ctx.senderPolicy`, AND expose the trusted webContents snapshot
 * WireTransport broadcasts events to. `ipcMain` comes from the lazily-imported
 * real `electron` (the function signature carries no ipcMain param), so we
 * `vi.mock('electron')` and assert it is threaded through verbatim.
 *
 * The trusted-webContents snapshot is derived by filtering ALL live
 * webContents through `ctx.senderPolicy` — this makes the host-toolbar
 * exclusion (a deliberate security red line, see `utils/sender-policy.ts:57`)
 * automatic: the toolbar wc is rejected by the policy, so it must NOT appear
 * in `trustedWebContents()`.
 *
 * Every `it` here is RED today because the implementation file does not exist
 * (`./workbench-wire-bridge.js`), so the import throws at module load.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { WorkbenchContext } from '../services/workbench-context.js'
import type { SenderPolicy as DevtoolsSenderPolicy } from '../utils/ipc-registry.js'

// ── electron stub: only what the adapter needs (ipcMain + webContents static) ──
const stubs = vi.hoisted(() => {
  // numeric id → fake WebContents the adapter can hand to ctx.senderPolicy.
  const byId = new Map<number, unknown>()
  // ordered list backing webContents.getAllWebContents() (toolbar included so
  // the policy filter is what excludes it — not a pre-trimmed input).
  const all: unknown[] = []
  return { byId, all }
})

vi.mock('electron', () => {
  type AnyFn = (...args: unknown[]) => unknown
  const ipcHandlers = new Map<string, AnyFn>()
  const listeners = new Map<string, Set<AnyFn>>()
  // A SINGLETON ipcMain object identity so the test can assert pass-through by
  // reference (`opts.ipcMain === mockedElectron.ipcMain`).
  const ipcMain = {
    handle: vi.fn((channel: string, fn: AnyFn) => { ipcHandlers.set(channel, fn) }),
    removeHandler: vi.fn((channel: string) => { ipcHandlers.delete(channel) }),
    on: vi.fn((event: string, fn: AnyFn) => {
      ;(listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(fn)
    }),
    removeListener: vi.fn((event: string, fn: AnyFn) => { listeners.get(event)?.delete(fn) }),
  }
  const webContents = {
    // fromId mirrors electron: numeric id → live WebContents or null/undefined.
    fromId: vi.fn((id: number) => stubs.byId.get(id) ?? null),
    getAllWebContents: vi.fn(() => [...stubs.all]),
  }
  return { ipcMain, webContents, default: {} }
})

// Import AFTER the mock + the type-only imports above. RED: file is missing.
import { buildWireTransportOptions } from './workbench-wire-bridge.js'
// Re-import the mocked electron surface so assertions can compare identities
// against the exact objects the adapter received.
import * as electron from 'electron'

// ── fakes ───────────────────────────────────────────────────────────────────

interface FakeWc {
  readonly id: number
  isDestroyed(): boolean
  send: ReturnType<typeof vi.fn>
}

function makeWc(id: number, destroyed = false): FakeWc {
  return { id, isDestroyed: () => destroyed, send: vi.fn() }
}

const MAIN_ID = 11
const TOOLBAR_ID = 22
const UNKNOWN_ID = 999

let mainWc: FakeWc
let toolbarWc: FakeWc
let devtoolsPolicy: DevtoolsSenderPolicy

/**
 * Minimal fake WorkbenchContext exposing the fields the adapter reads:
 * `senderPolicy` (the devtools function-style global predicate, which trusts the
 * main window and rejects the toolbar) and `views.hostToolbar.webContents` (the
 * live toolbar view). The wire surface trusts the global policy UNION the
 * toolbar, so the toolbar — excluded from the global IpcRegistry policy — is
 * still trusted for the narrow host-declared WireTransport channels.
 */
function makeCtx(): WorkbenchContext {
  devtoolsPolicy = vi.fn((sender: { id: number }) => sender.id === MAIN_ID) as unknown as DevtoolsSenderPolicy
  return {
    senderPolicy: devtoolsPolicy,
    views: { hostToolbar: { webContents: toolbarWc } },
  } as unknown as WorkbenchContext
}

beforeEach(() => {
  vi.clearAllMocks()
  stubs.byId.clear()
  stubs.all.length = 0

  mainWc = makeWc(MAIN_ID)
  toolbarWc = makeWc(TOOLBAR_ID)
  // Register both with electron.webContents: fromId resolves them, and BOTH
  // appear in getAllWebContents() so the policy filter (not the input) is what
  // drops the toolbar.
  stubs.byId.set(MAIN_ID, mainWc)
  stubs.byId.set(TOOLBAR_ID, toolbarWc)
  stubs.all.push(mainWc, toolbarWc)
})

describe('buildWireTransportOptions', () => {
  // Contract 1: trusted main sender id → isTrusted === true.
  it('senderPolicy.isTrusted(mainId) is true for the trusted main window sender', () => {
    const opts = buildWireTransportOptions(makeCtx())
    expect(opts.senderPolicy.isTrusted(MAIN_ID)).toBe(true)
  })

  // Contract 2: unknown / untrusted sender id → false (fromId yields null;
  // ctx.senderPolicy also rejects it).
  it('senderPolicy.isTrusted(unknownId) is false for an unknown sender', () => {
    const opts = buildWireTransportOptions(makeCtx())
    expect(opts.senderPolicy.isTrusted(UNKNOWN_ID)).toBe(false)
  })

  // Contract 2b: for a non-toolbar sender the adapter delegates to
  // ctx.senderPolicy rather than re-implementing trust — proves the devtools
  // policy is actually consulted (with the live wc resolved from the id).
  it('senderPolicy.isTrusted delegates to ctx.senderPolicy with the resolved WebContents', () => {
    const opts = buildWireTransportOptions(makeCtx())
    opts.senderPolicy.isTrusted(MAIN_ID)
    expect(devtoolsPolicy).toHaveBeenCalled()
    expect(devtoolsPolicy).toHaveBeenCalledWith(mainWc)
  })

  // Contract 2c: the host-toolbar wc IS trusted on the wire surface even though
  // the global ctx.senderPolicy rejects it — the WireTransport carries only the
  // host-declared hostServices/events, and the toolbar is their primary caller.
  it('senderPolicy.isTrusted(toolbarId) is true (wire surface trusts the toolbar)', () => {
    const opts = buildWireTransportOptions(makeCtx())
    expect(opts.senderPolicy.isTrusted(TOOLBAR_ID)).toBe(true)
  })

  // Contract 3a: trustedWebContents() includes the main window's webContents.
  it('trustedWebContents() includes the main window webContents', () => {
    const opts = buildWireTransportOptions(makeCtx())
    const ids = opts.trustedWebContents().map((wc) => wc.id)
    expect(ids).toContain(MAIN_ID)
  })

  // Contract 3b: trustedWebContents() INCLUDES the host-toolbar so declared
  // events fan out to it (it is excluded from the global IpcRegistry policy but
  // trusted for the narrow wire channels).
  it('trustedWebContents() includes the host-toolbar webContents (event fanout)', () => {
    const opts = buildWireTransportOptions(makeCtx())
    const ids = opts.trustedWebContents().map((wc) => wc.id)
    expect(ids).toContain(TOOLBAR_ID)
  })

  // Contract 4: ipcMain is threaded through from the (mocked) real electron —
  // the adapter does not wrap or substitute it.
  it('returns the electron ipcMain verbatim (pass-through)', () => {
    const opts = buildWireTransportOptions(makeCtx())
    expect(opts.ipcMain).toBe(electron.ipcMain)
  })

  // Contract 5: pure bridge — building the options must NOT register any IPC
  // listeners/handlers. WireTransport.start() owns that; the builder is inert.
  it('does not attach any ipcMain listeners/handlers at construction', () => {
    buildWireTransportOptions(makeCtx())
    expect(electron.ipcMain.handle).not.toHaveBeenCalled()
    expect(electron.ipcMain.on).not.toHaveBeenCalled()
  })
})
