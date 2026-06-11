/**
 * Connection-routed teardown for the native-host simulator WebContentsView.
 *
 * Contract (implemented; these tests pin it green):
 *
 *  1. `attachNativeSimulator(url, width)` creates the native simulator
 *     WebContentsView whose `.webContents` is `simWc`. That `simWc` MUST be
 *     tracked by the connection layer: `ctx.connections.get(simWc.id)` returns a
 *     LIVE connection whose `.webContents === simWc`.
 *
 *  2. `attachNativeSimulator` registers the native custom-api bridge via
 *     `ipcMain.on(SimulatorCustomApiBridgeChannel.Request, handler)`. When
 *     `simWc` emits `'destroyed'`, that ipcMain listener MUST be removed
 *     (`ipcMain.removeListener(channel, handler)`) AND the connection MUST close:
 *     `ctx.connections.get(simWc.id)` → undefined and `all()` no longer
 *     contains it.
 *
 * HOW IT WORKS: `attachNativeSimulator` acquires a connection for `simWc` and
 * owns the custom-api bridge detach through it
 * (`ctx.connections.acquire(simWc).own(detach)`). So assertion (1)
 * (`ctx.connections.get(simWc.id)` defined right after attach) holds, and the
 * connection close drives the bridge teardown.
 *
 * Harness notes:
 *  - The simulator WebContents stub is a REAL emitter (on/once/off/emit/
 *    removeListener) copied from connection-wiring.test.ts, so `once('destroyed')`
 *    actually fires on `emit('destroyed')` (both the production code's bespoke
 *    `once` and the connection registry's `wc.once('destroyed')` hook depend on
 *    this).
 *  - `ctx.connections` is the REAL `createConnectionRegistry()` — the whole point
 *    is to assert the genuine registry tracks/untracks the connection.
 *  - `ctx.simulatorApis` is the REAL registry so `attachNativeCustomApiBridge`
 *    runs past its early-return and actually calls `ipcMain.on(...)`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'
import { SimulatorCustomApiBridgeChannel } from '../../../shared/ipc-channels.js'

// ── shared mock state (hoisted so the electron factory can read it) ─────────
const stubs = vi.hoisted(() => {
  type AnyFn = (...args: unknown[]) => unknown
  type EventBag = Record<string, Set<AnyFn>>

  // Records of ipcMain.on / ipcMain.removeListener calls keyed by channel.
  const onCalls: Array<{ channel: string; handler: AnyFn }> = []
  const removeListenerCalls: Array<{ channel: string; handler: AnyFn }> = []

  // Real emitter: `once` self-removes; `emit` snapshots before firing.
  function makeEmitter() {
    const listeners: EventBag = {}
    return {
      listeners,
      on(event: string, fn: AnyFn) { (listeners[event] ??= new Set()).add(fn); return this },
      once(event: string, fn: AnyFn) {
        const wrap: AnyFn = (...a: unknown[]) => { listeners[event]?.delete(wrap); return fn(...a) }
        ;(listeners[event] ??= new Set()).add(wrap); return this
      },
      off(event: string, fn: AnyFn) { listeners[event]?.delete(fn); return this },
      removeListener(event: string, fn: AnyFn) { listeners[event]?.delete(fn); return this },
      emit(event: string, ...a: unknown[]) { for (const fn of [...(listeners[event] ?? [])]) fn(...a) },
    }
  }

  function reset() {
    onCalls.length = 0
    removeListenerCalls.length = 0
  }

  return { onCalls, removeListenerCalls, makeEmitter, reset }
})

vi.mock('electron', () => {
  type AnyFn = (...args: unknown[]) => unknown

  // ipcMain is itself a real emitter so the registered Request handler is a live
  // listener, AND we record on/removeListener so the test can assert teardown.
  const ipcEmitter = stubs.makeEmitter()
  const ipcMain = {
    ...ipcEmitter,
    handle: vi.fn(),
    removeHandler: vi.fn(),
    on: vi.fn((event: string, fn: AnyFn) => { stubs.onCalls.push({ channel: event, handler: fn }); ipcEmitter.on(event, fn) }),
    removeListener: vi.fn((event: string, fn: AnyFn) => { stubs.removeListenerCalls.push({ channel: event, handler: fn }); ipcEmitter.removeListener(event, fn) }),
  }

  let nextWcId = 1

  // Simulator WebContents — a REAL emitter so once('destroyed') fires.
  class WebContents {
    private em = stubs.makeEmitter()
    destroyed = false
    id = nextWcId++
    on = this.em.on.bind(this.em)
    once = this.em.once.bind(this.em)
    off = this.em.off.bind(this.em)
    removeListener = this.em.removeListener.bind(this.em)
    emit = this.em.emit.bind(this.em)
    send = vi.fn()
    isDestroyed = () => this.destroyed
    setWindowOpenHandler = vi.fn()
    setZoomFactor = vi.fn()
    loadURL = vi.fn(() => Promise.resolve())
    loadFile = vi.fn(() => Promise.resolve())
    setDevToolsWebContents = vi.fn()
    openDevTools = vi.fn()
    closeDevTools = vi.fn()
    isDevToolsOpened = () => false
    close = vi.fn(function (this: WebContents) { this.destroyed = true })
  }

  class WebContentsView {
    webContents = new WebContents()
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
    // accept (opts?) — attachNativeSimulator passes webPreferences
    constructor(_opts?: unknown) {}
  }

  return {
    ipcMain,
    WebContentsView,
    shell: { openExternal: vi.fn(() => Promise.resolve()) },
    webContents: {
      fromId: vi.fn(() => null),
      getAllWebContents: vi.fn(() => []),
    },
  }
})

vi.mock('../../utils/paths.js', () => ({
  mainPreloadPath: '/stub/preload.js',
  devtoolsPackageRoot: '/stub/devtools-pkg-root',
  // attachNativeSimulator resolves the simulator preload through this pure
  // string helper; keep the real `.js`→`.cjs` swap behaviour.
  cjsSiblingPreloadPath: (p: string) => (p.endsWith('.js') ? p.slice(0, -'.js'.length) + '.cjs' : p),
}))

// Import AFTER mocks so view-manager picks up the stubs.
import { createViewManager } from './view-manager.js'
import { createSimulatorApiRegistry } from '../simulator/custom-apis.js'

function makeContext() {
  const addChildView = vi.fn()
  const removeChildView = vi.fn()
  const contentView = { addChildView, removeChildView, children: [] as unknown[] }
  const mainWindow = {
    destroyed: false,
    contentView,
    isDestroyed() { return this.destroyed },
    getContentSize: () => [1280, 980],
  }
  const connections = createConnectionRegistry()
  // ViewManagerContext declares `connections`; provide the REAL registry on the
  // ctx so the production code routes teardown through it.
  const ctx = {
    windows: {
      mainWindow: mainWindow as unknown as import('electron').BrowserWindow,
    } as import('../window-service.js').WindowService,
    rendererDir: '/stub/renderer',
    panels: ['console', 'wxml', 'storage', 'appdata'],
    preloadPath: '/stub/sim-preload.js',
    simulatorApis: createSimulatorApiRegistry(),
    connections,
    notify: {} as unknown as import('../notifications/renderer-notifier.js').RendererNotifier,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  return { ctx, connections }
}

beforeEach(() => {
  stubs.reset()
})

describe('native simulator teardown is routed through ctx.connections', () => {
  it('tracks the simulator webContents as a LIVE connection right after attachNativeSimulator', () => {
    const { ctx, connections } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator('http://localhost:3000/simulator.html', 375)

    // The native simulator wc id is the one the manager reports as the
    // simulator webContents id.
    const simWcId = mgr.getSimulatorWebContentsId()
    expect(simWcId, 'attachNativeSimulator must set a simulator webContents id').not.toBeNull()

    const conn = connections.get(simWcId!)

    // ── THE PINNED ASSERTION ───────────────────────────────────────────────
    // attachNativeSimulator calls ctx.connections.acquire(simWc), so this is a
    // live connection after attach.
    expect(
      conn,
      'ctx.connections.get(simWc.id) must return a connection after attachNativeSimulator',
    ).toBeDefined()
    expect(conn!.alive, 'the simulator connection must be alive').toBe(true)
    expect(
      conn!.webContents.id,
      'the connection must wrap the simulator webContents',
    ).toBe(simWcId)
    expect(connections.all().some((c) => c.id === simWcId)).toBe(true)
  })

  it("removes the ipcMain bridge listener AND closes the connection when simWc emits 'destroyed'", () => {
    const { ctx, connections } = makeContext()
    const mgr = createViewManager(ctx)

    mgr.attachNativeSimulator('http://localhost:3000/simulator.html', 375)

    const simWcId = mgr.getSimulatorWebContentsId()
    expect(simWcId).not.toBeNull()

    // The custom-api bridge ipcMain.on was registered for the Request channel.
    const onCall = stubs.onCalls.find((c) => c.channel === SimulatorCustomApiBridgeChannel.Request)
    expect(onCall, 'attachNativeSimulator must register the custom-api bridge ipcMain.on listener').toBeDefined()

    // Precondition: connection tracked before destroy.
    expect(connections.get(simWcId!), 'precondition: connection exists before destroy').toBeDefined()

    // Resolve the live simulator webContents emitter and fire 'destroyed'.
    const conn = connections.get(simWcId!)
    ;(conn!.webContents as unknown as { emit: (e: string) => void }).emit('destroyed')

    // The ipcMain bridge listener was removed for the SAME channel + handler.
    const removed = stubs.removeListenerCalls.find(
      (c) => c.channel === SimulatorCustomApiBridgeChannel.Request && c.handler === onCall!.handler,
    )
    expect(
      removed,
      "the custom-api bridge ipcMain listener must be removed when simWc emits 'destroyed'",
    ).toBeDefined()

    // The connection closed: get(id) → undefined, all() no longer contains it.
    expect(
      connections.get(simWcId!),
      "ctx.connections.get(simWc.id) must be undefined after 'destroyed'",
    ).toBeUndefined()
    expect(connections.all().some((c) => c.id === simWcId)).toBe(false)
  })
})
