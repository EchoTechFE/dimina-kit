/**
 * bridge-router — `activePage` RenderEvent re-emitted once a render guest binds.
 *
 * PAGE_OPEN creates a PageSession with `renderWc: null` (bridge-router.ts's
 * SPAWN/PAGE_OPEN handlers never know the guest webContents up front). When
 * DeviceShell reports ACTIVE_PAGE for that bridgeId, `onActivePage` sets
 * `ap.activeBridgeId` and emits `{kind:'activePage', ...}` immediately — but
 * `getActiveRenderWc()` reads `page.renderWc`, which is still null at that
 * instant. The new guest only binds later, inside `ensureRenderBound`, the
 * first time it sends RENDER_INVOKE/RENDER_PUBLISH. Without a second
 * `activePage` at that bind, a subscriber that reacts to `activePage` to prime
 * a fresh DOM snapshot (see elements-forward/index.ts) would only ever see
 * `getActiveRenderWc() === null` for a page's first activation and silently
 * miss priming it.
 *
 * Pinned contract:
 *   - `ensureRenderBound` binding a webContents to a page that is the
 *     session's ACTIVE page (same rule as `getActiveBridgeId`: explicit
 *     `ap.activeBridgeId`, falling back to the still-alive root page before
 *     the first ACTIVE_PAGE signal) re-emits `activePage` for that bridgeId
 *     — and by the time listeners run, `getActiveRenderWc()` already
 *     resolves to the just-bound webContents.
 *   - Binding a page that is NOT the active one never emits `activePage`.
 *   - Re-binding the same sender to the same bridgeId a second time is a
 *     no-op — it must not re-emit.
 *
 * Driven through the REAL `installBridgeRouter` + its real IPC emitters
 * (SPAWN / PAGE_OPEN / ACTIVE_PAGE / RENDER_INVOKE), mirroring the harness in
 * bridge-router-storage-wxml-notify.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoisted electron stub state (mirrors bridge-router-storage-wxml-notify.test.ts) ─────
const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  const onListeners = new Map<string, Set<AnyFn>>()
  const invokeHandlers = new Map<string, AnyFn>()

  function makeEmitter() {
    const listeners: EventBag = {}
    const api = {
      listeners,
      on(event: string, fn: AnyFn) { (listeners[event] ??= new Set()).add(fn); return api },
      once(event: string, fn: AnyFn) {
        const wrap: AnyFn = (...a: unknown[]) => { listeners[event]?.delete(wrap); return fn(...a) }
        ;(listeners[event] ??= new Set()).add(wrap); return api
      },
      off(event: string, fn: AnyFn) { listeners[event]?.delete(fn); return api },
      removeListener(event: string, fn: AnyFn) { listeners[event]?.delete(fn); return api },
      listenerCount(event: string) { return listeners[event]?.size ?? 0 },
      emit(event: string, ...a: unknown[]) { for (const fn of [...(listeners[event] ?? [])]) fn(...a) },
    }
    return api
  }

  let nextWcId = 4000
  const wcById = new Map<number, ReturnType<typeof makeWebContents>>()
  function makeWebContents() {
    const em = makeEmitter()
    const sent: Array<{ channel: string; payload: unknown }> = []
    const wc = {
      ...em,
      id: nextWcId++,
      destroyed: false,
      isDestroyed() { return this.destroyed },
      getURL: () => 'about:blank',
      getType: () => 'window',
      send: vi.fn((channel: string, payload: unknown) => { sent.push({ channel, payload }) }),
      executeJavaScript: vi.fn(() => Promise.resolve(undefined)),
      openDevTools: vi.fn(),
      sentMessages: sent,
    }
    wcById.set(wc.id, wc)
    return wc
  }

  function makeBrowserWindow() {
    const em = makeEmitter()
    return {
      ...em,
      webContents: makeWebContents(),
      destroyed: false,
      isDestroyed() { return this.destroyed },
      close: vi.fn(function (this: { destroyed: boolean }) { this.destroyed = true }),
      loadURL: vi.fn(() => Promise.resolve()),
      loadFile: vi.fn(() => Promise.resolve()),
    }
  }

  function reset() {
    onListeners.clear()
    invokeHandlers.clear()
    wcById.clear()
    nextWcId = 4000
  }

  return { onListeners, invokeHandlers, wcById, makeEmitter, makeWebContents, makeBrowserWindow, reset }
})

vi.mock('electron', () => {
  type AnyFn = (...args: unknown[]) => unknown

  const ipcMain = {
    on: vi.fn((channel: string, fn: AnyFn) => {
      ;(stubs.onListeners.get(channel) ?? stubs.onListeners.set(channel, new Set()).get(channel)!).add(fn)
    }),
    removeListener: vi.fn((channel: string, fn: AnyFn) => {
      stubs.onListeners.get(channel)?.delete(fn)
    }),
    handle: vi.fn((channel: string, fn: AnyFn) => { stubs.invokeHandlers.set(channel, fn) }),
    removeHandler: vi.fn((channel: string) => { stubs.invokeHandlers.delete(channel) }),
  }

  const protocolStub = { handle: vi.fn(), unhandle: vi.fn(), registerSchemesAsPrivileged: vi.fn() }
  const sessionStub = {
    fromPartition: vi.fn(() => ({
      webRequest: { onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() },
      registerPreloadScript: vi.fn(),
      protocol: { handle: vi.fn(), unhandle: vi.fn() },
    })),
    defaultSession: { protocol: { handle: vi.fn(), unhandle: vi.fn() } },
  }

  return {
    ipcMain,
    app: { isPackaged: true, getLocale: () => 'en-US', getPath: vi.fn(() => '/tmp/dimina-test-userdata') },
    BrowserWindow: class {},
    WebContentsView: class { webContents = {}; setBounds = vi.fn(); setBackgroundColor = vi.fn() },
    protocol: protocolStub,
    session: sessionStub,
    webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
    nativeTheme: { themeSource: 'system', on: vi.fn() },
    default: {},
  }
})

vi.mock('@dimina-kit/electron-runtime/main/service-host-window', () => ({
  serviceHostSpec: () => ({}),
  serviceHostPreloadPath: '/tmp/preload.cjs',
  SERVICE_HOST_PARTITION: 'persist:simulator',
  buildServiceHostSpawnUrl: () => 'file:///service.html',
  navigateServiceHost: vi.fn(() => Promise.resolve()),
  createServiceHostWindow: vi.fn(() => stubs.makeBrowserWindow()),
  constructServiceHostWindow: vi.fn(() => stubs.makeBrowserWindow()),
}))

import { BRIDGE_CHANNELS as C } from '../../shared/bridge-channels.js'
import type { MessageEnvelope, PageOpenRequest, PageOpenResult, SpawnRequest, SpawnResult } from '../../shared/bridge-channels.js'
import type { WorkbenchContext } from '../services/workbench-context.js'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'
import type { RenderEvent } from './bridge-router.js'
import { installBridgeRouter } from './bridge-router.js'

type AnyFn = (...args: unknown[]) => unknown
type MockWc = ReturnType<typeof stubs.makeWebContents>

const APP_ID = 'demo-app'

beforeEach(() => {
  stubs.reset()
})

afterEach(() => {
  vi.clearAllMocks()
})

/** Fire an `ipcMain.on` channel as if a renderer/webview/service-host sent it. */
function emitOn(channel: string, sender: unknown, payload: unknown): void {
  const fns = stubs.onListeners.get(channel)
  if (!fns) throw new Error(`no ipcMain.on listener for ${channel}`)
  for (const fn of [...fns]) fn({ sender }, payload)
}

function makeCtx(): { ctx: WorkbenchContext; simulatorWc: MockWc } {
  const simulatorWc = stubs.makeWebContents()
  const ctx = {
    registry: { add: (_fn: AnyFn) => {} },
    connections: createConnectionRegistry(),
    simulatorApis: { has: (_name: string) => false, invoke: async () => ({}), list: () => [] },
    windows: { mainWindow: { webContents: simulatorWc } },
    workspace: { getSession: () => undefined },
    onServiceStorageChanged: vi.fn(),
  } as unknown as WorkbenchContext
  return { ctx, simulatorWc }
}

async function spawnSession(simulatorWc: MockWc): Promise<{ result: SpawnResult; serviceWc: MockWc }> {
  const handle = stubs.invokeHandlers.get(C.SPAWN)
  if (!handle) throw new Error('SPAWN handler not registered')
  const req: SpawnRequest = {
    appId: APP_ID,
    pagePath: 'pages/index/index',
    resourceBaseUrl: 'http://127.0.0.1:1/',
  }
  const result = (await (handle as AnyFn)({ sender: simulatorWc }, req)) as SpawnResult
  const serviceWc = stubs.wcById.get(result.serviceWcId)
  if (!serviceWc) throw new Error(`no mock webContents with id ${result.serviceWcId}`)
  return { result, serviceWc: serviceWc as unknown as MockWc }
}

/** Open a second-level page (non-root) via the real PAGE_OPEN handler. */
async function openPage(simulatorWc: MockWc, appSessionId: string, pagePath: string): Promise<PageOpenResult> {
  const handle = stubs.invokeHandlers.get(C.PAGE_OPEN)
  if (!handle) throw new Error('PAGE_OPEN handler not registered')
  const req: PageOpenRequest = { appSessionId, pagePath }
  return (await (handle as AnyFn)({ sender: simulatorWc }, req)) as PageOpenResult
}

/** Bind a fresh render-guest webContents to `bridgeId` via a benign RENDER_INVOKE. */
function bindRenderWc(bridgeId: string, renderWc: MockWc = stubs.makeWebContents()): MockWc {
  const msg: MessageEnvelope = { type: 'domReady', target: 'container', body: {} }
  emitOn(C.RENDER_INVOKE, renderWc, { bridgeId, msg })
  return renderWc
}

/** activePage events, each paired with what getActiveRenderWc() resolved to
 *  AT THE MOMENT the event fired (captured inside the listener — bridge-router
 *  swallows listener exceptions, so assertions must happen after collection,
 *  not inside the listener itself). */
function trackActivePage(ctx: WorkbenchContext): Array<{ event: RenderEvent; activeRenderWcId: number | null }> {
  const snapshots: Array<{ event: RenderEvent; activeRenderWcId: number | null }> = []
  ctx.bridge!.onRenderEvent((e) => {
    if (e.kind === 'activePage') {
      snapshots.push({ event: e, activeRenderWcId: ctx.bridge!.getActiveRenderWc()?.id ?? null })
    }
  })
  return snapshots
}

describe('bridge-router — activePage re-emitted once a render guest binds', () => {
  it('re-emits activePage for the root page once its guest binds, after getActiveRenderWc resolves to it', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const snapshots = trackActivePage(ctx)

    const { result } = await spawnSession(simulatorWc)
    emitOn(C.ACTIVE_PAGE, simulatorWc, { appSessionId: result.appSessionId, bridgeId: result.bridgeId })

    // Before any guest has bound, the signal fires but there is nothing to prime.
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.activeRenderWcId).toBeNull()

    const renderWc = bindRenderWc(result.bridgeId)

    expect(snapshots).toHaveLength(2)
    expect(snapshots[1]!.event).toEqual({
      kind: 'activePage',
      appId: APP_ID,
      bridgeId: result.bridgeId,
      pagePath: 'pages/index/index',
      query: {},
    })
    expect(snapshots[1]!.activeRenderWcId).toBe(renderWc.id)
  })

  it('re-emits activePage for a second-level page once ITS guest binds (not the root\'s)', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const snapshots = trackActivePage(ctx)

    const { result } = await spawnSession(simulatorWc)
    const detail = await openPage(simulatorWc, result.appSessionId, 'pages/detail/detail')
    emitOn(C.ACTIVE_PAGE, simulatorWc, { appSessionId: result.appSessionId, bridgeId: detail.bridgeId })

    // Root cause: activePage fired for the detail page, but no guest has bound
    // to it yet — this is the gap the re-emit-on-bind fix closes.
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.activeRenderWcId).toBeNull()

    const detailRenderWc = bindRenderWc(detail.bridgeId)

    expect(snapshots).toHaveLength(2)
    expect(snapshots[1]!.event).toEqual({
      kind: 'activePage',
      appId: APP_ID,
      bridgeId: detail.bridgeId,
      pagePath: 'pages/detail/detail',
      query: {},
    })
    expect(snapshots[1]!.activeRenderWcId).toBe(detailRenderWc.id)
  })

  it('falls back to the root page as active when no ACTIVE_PAGE signal has arrived yet', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const snapshots = trackActivePage(ctx)

    const { result } = await spawnSession(simulatorWc)
    // No ACTIVE_PAGE emitted — getActiveBridgeId's root fallback must still
    // recognize the root page as active once its guest binds.
    const renderWc = bindRenderWc(result.bridgeId)

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.event).toEqual({
      kind: 'activePage',
      appId: APP_ID,
      bridgeId: result.bridgeId,
      pagePath: 'pages/index/index',
      query: {},
    })
    expect(snapshots[0]!.activeRenderWcId).toBe(renderWc.id)
  })

  it('never emits activePage when a NON-active page\'s guest binds', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const snapshots = trackActivePage(ctx)

    const { result } = await spawnSession(simulatorWc)
    // Root's own guest binds (falls back to active pre-ACTIVE_PAGE) and the
    // explicit ACTIVE_PAGE(root) signal arrives — both name the root, so the
    // total count pins exactly two root events and zero for anything else.
    bindRenderWc(result.bridgeId)
    emitOn(C.ACTIVE_PAGE, simulatorWc, { appSessionId: result.appSessionId, bridgeId: result.bridgeId })
    const detail = await openPage(simulatorWc, result.appSessionId, 'pages/detail/detail')
    // ACTIVE_PAGE still names the root — detail is not (yet) the active page.
    bindRenderWc(detail.bridgeId)

    expect(snapshots).toHaveLength(2)
    expect(snapshots.every((s) => s.event.bridgeId === result.bridgeId)).toBe(true)
  })

  it('does not re-emit when the same sender binds to the same bridgeId again', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const snapshots = trackActivePage(ctx)

    const { result } = await spawnSession(simulatorWc)
    const renderWc = bindRenderWc(result.bridgeId)
    expect(snapshots).toHaveLength(1)

    // Same sender, same bridgeId, a second RENDER_INVOKE — ensureRenderBound
    // sees an already-bound sender and must not treat it as a fresh bind.
    bindRenderWc(result.bridgeId, renderWc)

    expect(snapshots).toHaveLength(1)
  })

  it('does not let a superseded render guest reclaim ownership on a late bind', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const snapshots = trackActivePage(ctx)

    const { result } = await spawnSession(simulatorWc)
    const wcA = bindRenderWc(result.bridgeId)
    expect(snapshots).toHaveLength(1)

    const wcB = bindRenderWc(result.bridgeId)
    expect(snapshots).toHaveLength(2)

    // wcA is still alive (not destroyed) but wcB already replaced it above — a
    // late RENDER_INVOKE arriving from wcA must not reclaim `renderWc` or
    // re-emit activePage on its behalf.
    bindRenderWc(result.bridgeId, wcA)

    expect(snapshots).toHaveLength(2)
    expect(ctx.bridge!.getActiveRenderWc()?.id).toBe(wcB.id)
  })

  it('does not emit activePage for a page bound in a session superseded by a newer same-appId spawn', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const snapshots = trackActivePage(ctx)

    const { result: sessionA } = await spawnSession(simulatorWc)
    const { result: sessionB } = await spawnSession(simulatorWc)
    expect(sessionA.appSessionId).not.toBe(sessionB.appSessionId)

    // sessionA's root page gets a guest bound, but sessionB — spawned after it,
    // same appId — is the session `findAppSessionByAppId` now resolves to.
    // sessionA's bind must not surface as the app's active page.
    bindRenderWc(sessionA.bridgeId)
    expect(snapshots).toHaveLength(0)

    const renderWcB = bindRenderWc(sessionB.bridgeId)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.event.bridgeId).toBe(sessionB.bridgeId)
    expect(snapshots[0]!.activeRenderWcId).toBe(renderWcB.id)
  })

  it('discards a late bind from an already-destroyed sender instead of reclaiming ownership from the live guest', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)
    const snapshots = trackActivePage(ctx)

    const { result, serviceWc } = await spawnSession(simulatorWc)
    const wcA = bindRenderWc(result.bridgeId)
    expect(snapshots).toHaveLength(1)

    // A is destroyed but its connection-registry teardown (the real 'destroyed'
    // listener that nulls page.renderWc / drops wcIdToBridgeId) has not run
    // yet — the async-cleanup window a still-in-flight message can land in.
    wcA.destroyed = true

    const wcB = bindRenderWc(result.bridgeId)
    expect(snapshots).toHaveLength(2)

    // A's late RENDER_INVOKE must be rejected outright: a destroyed sender is
    // never a valid owner, regardless of supersededRenderWcIds bookkeeping.
    bindRenderWc(result.bridgeId, wcA)

    expect(snapshots).toHaveLength(2)
    expect(ctx.bridge!.getActiveRenderWc()?.id).toBe(wcB.id)

    // B must still be able to route normally afterward — the dead sender's
    // message must not have knocked B out of ownership.
    const sendCountBefore = serviceWc.send.mock.calls.length
    const msg: MessageEnvelope = { type: 'domReady', target: 'container', body: {} }
    emitOn(C.RENDER_PUBLISH, wcB, { bridgeId: result.bridgeId, msg })
    expect(serviceWc.send.mock.calls.length).toBe(sendCountBefore + 1)
  })

  it('drops the superseded guest\'s wcIdToBridgeId entry as soon as a live sender replaces it', async () => {
    const { ctx, simulatorWc } = makeCtx()
    installBridgeRouter(ctx)

    const { result } = await spawnSession(simulatorWc)
    bindRenderWc(result.bridgeId)
    bindRenderWc(result.bridgeId)

    // Both binds are still-alive senders — the old one is superseded, not
    // destroyed, so only its connection-registry ownership moves; its
    // wcIdToBridgeId row must move with it rather than sitting alongside the
    // new owner's.
    expect(ctx.bridge!.census!().renderWcBindings).toBe(1)
  })
})
