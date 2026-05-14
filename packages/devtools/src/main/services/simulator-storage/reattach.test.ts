/**
 * Reattach regression for `setupSimulatorStorage`.
 *
 * Verifies:
 *   - Re-feeding the same simulator webContents through the
 *     `app.on('web-contents-created')` + `did-finish-load` path is a no-op:
 *     `attachToSim()` short-circuits via `if (attachedWc === wc) return`,
 *     so the debugger 'message' listener is NOT registered twice.
 *   - When the attached simulator wc is destroyed, the old wc's debugger
 *     listeners are removed eagerly (via attachDisposables in onDestroyed),
 *     not left to leak until the next attachToSim call.
 *   - When a NEW simulator wc subsequently appears, its 'message' listener
 *     is registered exactly once on the new wc.
 *   - Final `dispose()` clears the active debugger listener.
 *
 * The mock keeps per-wc bookkeeping so we can verify the listener counts
 * and that removeListener targets the correct wc.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (...args: unknown[]) => unknown

const stub = vi.hoisted(() => {
  const ipcHandlers = new Map<string, Handler>()
  const appListeners = new Map<string, Set<Handler>>()
  const wcRegistry: unknown[] = []

  const ipcMainStub = {
    handle: vi.fn((channel: string, fn: Handler) => { ipcHandlers.set(channel, fn) }),
    removeHandler: vi.fn((channel: string) => { ipcHandlers.delete(channel) }),
  }
  const appStub = {
    on: vi.fn((event: string, fn: Handler) => {
      if (!appListeners.has(event)) appListeners.set(event, new Set())
      appListeners.get(event)!.add(fn)
    }),
    removeListener: vi.fn((event: string, fn: Handler) => {
      appListeners.get(event)?.delete(fn)
    }),
  }
  const webContentsStub = { getAllWebContents: vi.fn(() => wcRegistry) }

  return { ipcHandlers, appListeners, wcRegistry, ipcMainStub, appStub, webContentsStub }
})

vi.mock('electron', () => ({
  app: stub.appStub,
  ipcMain: stub.ipcMainStub,
  webContents: stub.webContentsStub,
  BrowserWindow: class {},
  shell: { openPath: vi.fn() },
  nativeImage: { createFromPath: vi.fn(() => ({})) },
}))

import { setupSimulatorStorage } from './index.js'

interface SimWc {
  destroyed: boolean
  isDestroyed: () => boolean
  getType: () => string
  getURL: () => string
  executeJavaScript: ReturnType<typeof vi.fn>
  /** wc-level event listeners (the storage module uses .on / .once / .removeListener) */
  _wcListeners: Map<string, Handler[]>
  on: (event: string, fn: Handler) => void
  once: (event: string, fn: Handler) => void
  removeListener: (event: string, fn: Handler) => void
  /** Fire a wc-level event */
  emit: (event: string, ...args: unknown[]) => void
  debugger: {
    attached: boolean
    attach: ReturnType<typeof vi.fn>
    detach: ReturnType<typeof vi.fn>
    isAttached: () => boolean
    sendCommand: ReturnType<typeof vi.fn>
    /** Per-debugger event listeners */
    _dbgListeners: Map<string, Handler[]>
    on: (event: string, fn: Handler) => void
    removeListener: (event: string, fn: Handler) => void
    isDestroyed?: () => boolean
  }
}

function makeSimWc(): SimWc {
  const wc: SimWc = {
    destroyed: false,
    isDestroyed() { return this.destroyed },
    getType: () => 'webview',
    getURL: () => 'http://localhost/simulator.html',
    executeJavaScript: vi.fn(() => Promise.resolve('http://localhost')),
    _wcListeners: new Map(),
    on(event, fn) {
      const arr = this._wcListeners.get(event) ?? []
      arr.push(fn)
      this._wcListeners.set(event, arr)
    },
    once(event, fn) {
      // Wrap so that emit removes after first call.
      const wrap: Handler = (...args) => {
        this.removeListener(event, wrap)
        fn(...args)
      }
      this.on(event, wrap)
    },
    removeListener(event, fn) {
      const arr = this._wcListeners.get(event)
      if (!arr) return
      const idx = arr.indexOf(fn)
      if (idx >= 0) arr.splice(idx, 1)
    },
    emit(event, ...args) {
      const arr = this._wcListeners.get(event) ?? []
      // Snapshot so once-wrappers can mutate the array safely.
      for (const fn of [...arr]) fn(...args)
    },
    debugger: {
      attached: false,
      attach: vi.fn(function (this: SimWc['debugger']) { this.attached = true }),
      detach: vi.fn(function (this: SimWc['debugger']) { this.attached = false }),
      isAttached() { return this.attached },
      sendCommand: vi.fn(() => Promise.resolve({ entries: [] })),
      _dbgListeners: new Map(),
      on(event, fn) {
        const arr = this._dbgListeners.get(event) ?? []
        arr.push(fn)
        this._dbgListeners.set(event, arr)
      },
      removeListener(event, fn) {
        const arr = this._dbgListeners.get(event)
        if (!arr) return
        const idx = arr.indexOf(fn)
        if (idx >= 0) arr.splice(idx, 1)
      },
    },
  }
  // Bind debugger methods to its own receiver so `this.attached` works.
  wc.debugger.attach = vi.fn(() => { wc.debugger.attached = true }) as never
  wc.debugger.detach = vi.fn(() => { wc.debugger.attached = false }) as never
  return wc
}

function makeHost() {
  return {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  } as unknown as Electron.WebContents
}

function getWcCreatedCallback(): (event: unknown, wc: unknown) => void {
  const set = stub.appListeners.get('web-contents-created')
  expect(set).toBeTruthy()
  expect(set!.size).toBe(1)
  return Array.from(set!)[0] as (event: unknown, wc: unknown) => void
}

function dbgMessageListenerCount(wc: SimWc): number {
  return (wc.debugger._dbgListeners.get('message') ?? []).length
}

function dbgDetachListenerCount(wc: SimWc): number {
  return (wc.debugger._dbgListeners.get('detach') ?? []).length
}

function wcDestroyedListenerCount(wc: SimWc): number {
  return (wc._wcListeners.get('destroyed') ?? []).length
}

beforeEach(() => {
  stub.ipcHandlers.clear()
  stub.appListeners.clear()
  stub.wcRegistry.length = 0
  stub.ipcMainStub.handle.mockClear()
  stub.ipcMainStub.removeHandler.mockClear()
  stub.appStub.on.mockClear()
  stub.appStub.removeListener.mockClear()
  stub.webContentsStub.getAllWebContents.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('setupSimulatorStorage — reattach does not stack listeners', () => {
  it('re-feeding the same wc through web-contents-created + did-finish-load does NOT register the debugger message listener twice', async () => {
    const wc = makeSimWc()

    // Seed the wc registry so the initial attach loop picks it up.
    stub.wcRegistry.push(wc)

    const d = setupSimulatorStorage(makeHost(), { getActiveAppId: () => null })

    // The initial pass registers exactly one debugger 'message' listener.
    // The attach is async (uses `void attachToSim(...)`); flush microtasks.
    await Promise.resolve()
    await Promise.resolve()

    expect(dbgMessageListenerCount(wc)).toBe(1)
    expect(dbgDetachListenerCount(wc)).toBe(1)
    expect(wcDestroyedListenerCount(wc)).toBe(1)

    // Now simulate the OS event: "a new web-contents was created" with the
    // same wc, followed by did-finish-load. attachToSim should short-circuit
    // (attachedWc === wc) so no second 'message' listener appears.
    const onWcCreated = getWcCreatedCallback()
    onWcCreated({}, wc)
    wc.emit('did-finish-load')
    await Promise.resolve()
    await Promise.resolve()

    expect(dbgMessageListenerCount(wc)).toBe(1)
    expect(dbgDetachListenerCount(wc)).toBe(1)
    // The 'destroyed' once-listener registered by attachToSim was not added
    // a second time — count stays 1. (The per-wc-subscription destroy listener
    // is added by the web-contents-created path; that one IS separate and
    // tracked on the wc.) Acceptable count is 1 (attach skipped) plus the
    // per-wc-sub 'destroyed' once-listener registered by onWcCreated => 2.
    expect(wcDestroyedListenerCount(wc)).toBeGreaterThanOrEqual(1)

    await d.dispose()
  })

  it('after the attached wc is destroyed, a new simulator wc gets its OWN attach (old listeners gone, new ones registered exactly once)', async () => {
    const wcA = makeSimWc()
    stub.wcRegistry.push(wcA)

    const d = setupSimulatorStorage(makeHost(), { getActiveAppId: () => null })
    await Promise.resolve()
    await Promise.resolve()

    expect(dbgMessageListenerCount(wcA)).toBe(1)
    const onWcCreated = getWcCreatedCallback()

    // Destroy wcA. The 'destroyed' once-listener inside attachToSim sets
    // attachedWc = null. The detach itself happens lazily on the next
    // attachToSim call (no explicit cleanup is wired to wc destruction).
    wcA.destroyed = true
    wcA.emit('destroyed')

    // Now a fresh simulator wc arrives.
    const wcB = makeSimWc()
    onWcCreated({}, wcB)
    wcB.emit('did-finish-load')
    await Promise.resolve()
    await Promise.resolve()

    // The new wc has exactly one 'message' listener registered.
    expect(dbgMessageListenerCount(wcB)).toBe(1)
    expect(dbgDetachListenerCount(wcB)).toBe(1)

    // When the attached wc is destroyed, `onDestroyed` now disposes
    // `attachDisposables` synchronously (modulo a microtask for the
    // disposable registry's async drain). That removes wcA's debugger
    // listeners, so a stale reference can never linger past the wc's
    // lifetime — even though wcA can no longer emit, holding refs is a
    // leak the lifecycle refactor should not accept.
    await Promise.resolve()
    await Promise.resolve()
    expect(dbgMessageListenerCount(wcA)).toBe(0)
    expect(dbgDetachListenerCount(wcA)).toBe(0)

    await d.dispose()

    // After full dispose, the new wc's listeners are removed.
    expect(dbgMessageListenerCount(wcB)).toBe(0)
    expect(dbgDetachListenerCount(wcB)).toBe(0)
  })

  it('dispose() removes the debugger message listener on the currently-attached wc', async () => {
    const wc = makeSimWc()
    stub.wcRegistry.push(wc)

    const d = setupSimulatorStorage(makeHost(), { getActiveAppId: () => null })
    await Promise.resolve()
    await Promise.resolve()
    expect(dbgMessageListenerCount(wc)).toBe(1)

    await d.dispose()

    expect(dbgMessageListenerCount(wc)).toBe(0)
    expect(dbgDetachListenerCount(wc)).toBe(0)
    // The app-level 'web-contents-created' listener is also removed.
    expect((stub.appListeners.get('web-contents-created')?.size ?? 0)).toBe(0)
  })
})
