/**
 * Characterization tests for the 5 storage-operation methods of
 * setupSimulatorStorage (M5 refactor guard).
 *
 * These tests nail down the failure-semantics divergence that M5 must preserve:
 *   - READ ops  (getSnapshot)                → fail silently → []
 *   - WRITE ops (setItem/removeItem/clearScoped/clearAll) → fail explicitly →
 *       { ok: false, error: 'simulator not attached' }         (no wc)
 *       { ok: false, error: 'failed to resolve simulator origin' } (no origin)
 *
 * If a refactor accidentally merges the two code paths and returns the same
 * shape in both cases, the assertions here will red immediately.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (...args: unknown[]) => unknown

const stub = vi.hoisted(() => {
  const ipcHandlers = new Map<string, Handler>()
  const appListeners = new Map<string, Set<Handler>>()
  const wcRegistry: unknown[] = []

  const ipcMainStub = {
    handle: vi.fn((channel: string, fn: Handler) => {
      ipcHandlers.set(channel, fn)
    }),
    removeHandler: vi.fn((channel: string) => {
      ipcHandlers.delete(channel)
    }),
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

import { SimulatorStorageChannel } from '../../../shared/ipc-channels.js'
import { setupSimulatorStorage } from './index.js'

/** Minimal fake host WebContents – never destroyed, never used in these tests. */
function makeHost() {
  return {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  } as unknown as Electron.WebContents
}

/**
 * A simulator WebContents stub that has fully attached and whose
 * executeJavaScript can be configured to succeed or fail.
 */
interface SimWc {
  destroyed: boolean
  isDestroyed(): boolean
  getType(): string
  getURL(): string
  executeJavaScript: ReturnType<typeof vi.fn>
  _wcListeners: Map<string, Handler[]>
  on(event: string, fn: Handler): void
  once(event: string, fn: Handler): void
  removeListener(event: string, fn: Handler): void
  emit(event: string, ...args: unknown[]): void
  debugger: {
    attached: boolean
    attach: ReturnType<typeof vi.fn>
    detach: ReturnType<typeof vi.fn>
    isAttached(): boolean
    sendCommand: ReturnType<typeof vi.fn>
    _dbgListeners: Map<string, Handler[]>
    on(event: string, fn: Handler): void
    removeListener(event: string, fn: Handler): void
    isDestroyed?: () => boolean
  }
}

function makeSimWc(opts?: { originError?: boolean }): SimWc {
  const wc: SimWc = {
    destroyed: false,
    isDestroyed() { return this.destroyed },
    getType: () => 'webview',
    getURL: () => 'http://localhost/simulator.html',
    executeJavaScript: opts?.originError
      ? vi.fn(() => Promise.reject(new Error('js eval failed')))
      : vi.fn(() => Promise.resolve('http://localhost')),
    _wcListeners: new Map(),
    on(event, fn) {
      const arr = this._wcListeners.get(event) ?? []
      arr.push(fn)
      this._wcListeners.set(event, arr)
    },
    once(event, fn) {
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
      for (const fn of [...(this._wcListeners.get(event) ?? [])]) fn(...args)
    },
    debugger: {
      attached: false,
      attach: vi.fn(),
      detach: vi.fn(),
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
  wc.debugger.attach = vi.fn(() => { wc.debugger.attached = true }) as never
  wc.debugger.detach = vi.fn(() => { wc.debugger.attached = false }) as never
  return wc
}

/** Invoke a registered IPC handler as if called from a renderer. */
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = stub.ipcHandlers.get(channel)
  if (!fn) throw new Error(`No handler registered for channel: ${channel}`)
  // Mimic the IpcMainInvokeEvent shape – only .sender is accessed by the guard
  // (and we have no senderPolicy in tests, so it is ignored).
  const fakeEvent = { sender: makeHost() }
  return fn(fakeEvent, ...args)
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

// ────────────────────────────────────────────────────────────────────────────
// Scenario A: no simulator webview exists at all
// ensureAttached() finds nothing → attachedWc stays null → "not attached" path
// ────────────────────────────────────────────────────────────────────────────
describe('storage-ops — no simulator webview', () => {
  it('getSnapshot returns [] (read is tolerant)', async () => {
    // wcRegistry is empty → no simulator → attachedWc stays null
    const d = setupSimulatorStorage(makeHost(), { getActiveAppId: () => null })

    const result = await invoke(SimulatorStorageChannel.GetSnapshot)

    expect(result).toEqual([])
    await d.dispose()
  })

  it('setItem returns { ok:false, error:"simulator not attached" }', async () => {
    const d = setupSimulatorStorage(makeHost(), { getActiveAppId: () => null })

    const result = await invoke(SimulatorStorageChannel.Set, { key: 'k', value: 'v' })

    expect(result).toEqual({ ok: false, error: 'simulator not attached' })
    await d.dispose()
  })

  it('removeItem returns { ok:false, error:"simulator not attached" }', async () => {
    const d = setupSimulatorStorage(makeHost(), { getActiveAppId: () => null })

    const result = await invoke(SimulatorStorageChannel.Remove, { key: 'k' })

    expect(result).toEqual({ ok: false, error: 'simulator not attached' })
    await d.dispose()
  })

  it('clearScoped returns { ok:false, error:"simulator not attached" }', async () => {
    const d = setupSimulatorStorage(makeHost(), { getActiveAppId: () => null })

    const result = await invoke(SimulatorStorageChannel.Clear)

    expect(result).toEqual({ ok: false, error: 'simulator not attached' })
    await d.dispose()
  })

  it('clearAll returns { ok:false, error:"simulator not attached" }', async () => {
    const d = setupSimulatorStorage(makeHost(), { getActiveAppId: () => null })

    const result = await invoke(SimulatorStorageChannel.ClearAll)

    expect(result).toEqual({ ok: false, error: 'simulator not attached' })
    await d.dispose()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Scenario B: simulator webview exists but executeJavaScript throws
// → attachedWc is set, but getStorageId() returns null ("origin failure" path)
// ────────────────────────────────────────────────────────────────────────────
describe('storage-ops — simulator attached but origin resolution fails', () => {
  async function setupWithOriginFailure() {
    const sim = makeSimWc({ originError: true })
    stub.wcRegistry.push(sim)
    const d = setupSimulatorStorage(makeHost(), { getActiveAppId: () => null })
    // Let attachToSim (void async) run via microtasks
    await Promise.resolve()
    await Promise.resolve()
    return { sim, d }
  }

  it('getSnapshot returns [] when origin resolution fails (read is tolerant)', async () => {
    const { d } = await setupWithOriginFailure()

    const result = await invoke(SimulatorStorageChannel.GetSnapshot)

    expect(result).toEqual([])
    await d.dispose()
  })

  it('setItem returns { ok:false, error:"failed to resolve simulator origin" }', async () => {
    const { d } = await setupWithOriginFailure()

    const result = await invoke(SimulatorStorageChannel.Set, { key: 'k', value: 'v' })

    expect(result).toEqual({ ok: false, error: 'failed to resolve simulator origin' })
    await d.dispose()
  })

  it('removeItem returns { ok:false, error:"failed to resolve simulator origin" }', async () => {
    const { d } = await setupWithOriginFailure()

    const result = await invoke(SimulatorStorageChannel.Remove, { key: 'k' })

    expect(result).toEqual({ ok: false, error: 'failed to resolve simulator origin' })
    await d.dispose()
  })

  it('clearScoped returns { ok:false, error:"failed to resolve simulator origin" }', async () => {
    const { d } = await setupWithOriginFailure()

    const result = await invoke(SimulatorStorageChannel.Clear)

    expect(result).toEqual({ ok: false, error: 'failed to resolve simulator origin' })
    await d.dispose()
  })

  it('clearAll returns { ok:false, error:"failed to resolve simulator origin" }', async () => {
    const { d } = await setupWithOriginFailure()

    const result = await invoke(SimulatorStorageChannel.ClearAll)

    expect(result).toEqual({ ok: false, error: 'failed to resolve simulator origin' })
    await d.dispose()
  })
})
