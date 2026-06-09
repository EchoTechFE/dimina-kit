/**
 * Lifecycle regression for `startAutomationServer`.
 *
 * What we verify (without standing up a real Electron simulator):
 *   - the AutomationChannel.GetPort handler is registered through an
 *     IpcRegistry that consults `ctx.senderPolicy`, and is removed on close()
 *   - the simulator `ipc-message-host` listener is attached once the polling
 *     interval picks a sim, AND is detached on close() via a NAMED handler
 *     (so repeated create/dispose cycles don't accumulate listeners)
 *   - if the sim emits 'destroyed' before close(), our refs drop without
 *     calling removeListener on a dead sender
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Electron stub (hoisted so vi.mock factory can reference it) ─────────
const stub = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown
  const ipcHandlers = new Map<string, Handler>()
  const guardedFns = new Map<string, Handler>()

  const ipcMainStub = {
    handle: vi.fn((channel: string, fn: Handler) => {
      ipcHandlers.set(channel, fn)
      guardedFns.set(channel, fn)
    }),
    removeHandler: vi.fn((channel: string) => {
      ipcHandlers.delete(channel)
      guardedFns.delete(channel)
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  }

  return { ipcHandlers, guardedFns, ipcMainStub }
})

const { ipcHandlers, guardedFns, ipcMainStub } = stub

vi.mock('electron', () => ({
  ipcMain: stub.ipcMainStub,
  app: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  BrowserWindow: class {},
}))

// ws stub: emulate the WebSocketServer surface used by startAutomationServer.
const wssStub = vi.hoisted(() => {
  const created: Array<{
    on: ReturnType<typeof vi.fn>
    once: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    address: ReturnType<typeof vi.fn>
    emit: (event: string, ...args: unknown[]) => void
  }> = []
  class WebSocketServerStub {
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    constructor(_opts: unknown) {
      const self = {
        on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
          if (!this.listeners.has(event)) this.listeners.set(event, [])
          this.listeners.get(event)!.push(fn)
        }),
        once: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
          if (event === 'listening') queueMicrotask(() => fn())
          else if (!this.listeners.has(event)) this.listeners.set(event, [fn])
          else this.listeners.get(event)!.push(fn)
        }),
        close: vi.fn(),
        address: vi.fn(() => ({ port: 54321 })),
        emit: (event: string, ...args: unknown[]) => {
          for (const fn of this.listeners.get(event) ?? []) fn(...args)
        },
      }
      created.push(self)
      return self as unknown as WebSocketServerStub
    }
  }
  return { created, WebSocketServerStub }
})

vi.mock('ws', () => ({
  WebSocketServer: wssStub.WebSocketServerStub,
}))

// Import AFTER the mocks so the module picks up the stubs.
import { AutomationChannel } from '../../../shared/ipc-channels.js'
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'
import { startAutomationServer } from './index.js'
import { getSimulator } from './exec.js'

vi.mock('./exec.js', async () => {
  const actual = await vi.importActual<typeof import('./exec.js')>('./exec.js')
  return { ...actual, getSimulator: vi.fn() }
})

const getSimulatorMock = vi.mocked(getSimulator)

function makeCtx(senderPolicy: (s: unknown) => boolean = () => true) {
  return {
    senderPolicy,
    // Real connection registry — the destroyed-teardown is routed through
    // `ctx.connections.acquire(sim).own(...)` rather than a bespoke
    // `sim.once('destroyed')`. The registry is a pure primitive (no Electron),
    // so the sim stub's `once('destroyed')` / `isDestroyed()` drive it faithfully.
    connections: createConnectionRegistry(),
    views: { getSimulatorWebContentsId: () => 1 },
    workspace: { hasActiveSession: () => true },
  } as unknown as Parameters<typeof startAutomationServer>[0]
}

function makeSim() {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>()
  return {
    // Stable wc.id so the ConnectionRegistry keys this sim deterministically.
    id: 1,
    isDestroyed: vi.fn(() => false),
    on: vi.fn((event: string, fn: (...a: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event)!.push(fn)
    }),
    once: vi.fn((event: string, fn: (...a: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event)!.push(fn)
    }),
    removeListener: vi.fn((event: string, fn: (...a: unknown[]) => void) => {
      const arr = listeners.get(event)
      if (!arr) return
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    }),
    _listenerCount: (event: string) => listeners.get(event)?.length ?? 0,
    _emit: (event: string, ...args: unknown[]) => {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(...args)
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  ipcHandlers.clear()
  guardedFns.clear()
  ipcMainStub.handle.mockClear()
  ipcMainStub.removeHandler.mockClear()
  wssStub.created.length = 0
  getSimulatorMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startAutomationServer lifecycle', () => {
  it('registers AutomationChannel.GetPort through a sender-policy gated registry and removes it on close()', async () => {
    const policy = vi.fn(() => true)
    const ctx = makeCtx(policy)

    const server = await startAutomationServer(ctx, 0)

    expect(ipcMainStub.handle).toHaveBeenCalledWith(AutomationChannel.GetPort, expect.any(Function))
    // The handler stored is the IpcRegistry guard, not the raw () => currentPort.
    const guarded = guardedFns.get(AutomationChannel.GetPort)!
    expect(guarded).toBeTypeOf('function')

    // Invoking through the guard with a fake event consults the policy.
    const fakeSender = { id: 7, isDestroyed: () => false, getURL: () => 'devtools://main' }
    await guarded({ sender: fakeSender } as unknown as { sender: unknown })
    expect(policy).toHaveBeenCalledWith(fakeSender)

    server.close()
    expect(ipcMainStub.removeHandler).toHaveBeenCalledWith(AutomationChannel.GetPort)
    expect(ipcHandlers.has(AutomationChannel.GetPort)).toBe(false)
  })

  it('rejects callers when senderPolicy returns false', async () => {
    const policy = vi.fn(() => false)
    const ctx = makeCtx(policy)
    const server = await startAutomationServer(ctx, 0)

    const guarded = guardedFns.get(AutomationChannel.GetPort)!
    // The IpcRegistry sender gate now surfaces as a rejected promise (the
    // invoke-result contract) rather than a synchronous throw.
    await expect(
      guarded({ sender: { id: 99, isDestroyed: () => false, getURL: () => 'devtools://evil' } } as unknown as { sender: unknown }),
    ).rejects.toThrow(/sender rejected/i)

    server.close()
  })

  it('detaches the ipc-message-host listener on close (no leak across cycles)', async () => {
    const ctx = makeCtx()
    const sim = makeSim()
    getSimulatorMock.mockReturnValue(sim as unknown as ReturnType<typeof getSimulator>)

    const server = await startAutomationServer(ctx, 0)

    // Simulate a ws connection arriving — that calls setupConsoleForwarding.
    const wss = wssStub.created[0]!
    wss.emit('connection', {
      readyState: 1,
      OPEN: 1,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    })

    // The polling interval fires every 1s. Advance once so it picks up the sim
    // and attaches the listener.
    await vi.advanceTimersByTimeAsync(1000)

    expect(sim.on).toHaveBeenCalledWith('ipc-message-host', expect.any(Function))
    // The destroyed-teardown is owned by the connection registry, which arms a
    // single `sim.once('destroyed')` internally (not a bespoke one here).
    expect(sim.once).toHaveBeenCalledWith('destroyed', expect.any(Function))
    expect(sim._listenerCount('ipc-message-host')).toBe(1)

    server.close()

    // ipc-message-host is still detached directly. The destroyed teardown is NOT
    // unwound via removeListener anymore — it's released by disposing the
    // connection-owned handle (the registry keeps its own once('destroyed')).
    expect(sim.removeListener).toHaveBeenCalledWith('ipc-message-host', expect.any(Function))
    expect(sim.removeListener).not.toHaveBeenCalledWith('destroyed', expect.any(Function))
    expect(sim._listenerCount('ipc-message-host')).toBe(0)
  })

  it('routes the simulator destroyed-teardown through the connection registry', async () => {
    const ctx = makeCtx()
    const sim = makeSim()
    getSimulatorMock.mockReturnValue(sim as unknown as ReturnType<typeof getSimulator>)

    const server = await startAutomationServer(ctx, 0)

    const wss = wssStub.created[0]!
    wss.emit('connection', { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn(), on: vi.fn() })

    // Pick up the sim — this acquires its connection and owns onSimDestroyed.
    await vi.advanceTimersByTimeAsync(1000)
    expect(sim._listenerCount('ipc-message-host')).toBe(1)

    // Firing the wc's real 'destroyed' event drives the registry connection,
    // which runs the owned teardown: the ipc-message-host handler is dropped and
    // the forwarding setup is reset so a fresh sim can re-attach.
    sim._emit('destroyed')
    sim.isDestroyed.mockReturnValue(true)

    // close() must not touch the dead sim's listeners.
    sim.removeListener.mockClear()
    server.close()
    expect(sim.removeListener).not.toHaveBeenCalled()
  })

  it('drops refs cleanly when the simulator emits destroyed before close()', async () => {
    const ctx = makeCtx()
    const sim = makeSim()
    getSimulatorMock.mockReturnValue(sim as unknown as ReturnType<typeof getSimulator>)

    const server = await startAutomationServer(ctx, 0)

    const wss = wssStub.created[0]!
    wss.emit('connection', { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn(), on: vi.fn() })

    await vi.advanceTimersByTimeAsync(1000)
    expect(sim._listenerCount('ipc-message-host')).toBe(1)

    // Sim webContents is torn down; emit 'destroyed'. After this point the
    // sim is conceptually dead, so close() must NOT try to call
    // removeListener on it.
    sim._emit('destroyed')
    sim.isDestroyed.mockReturnValue(true)
    sim.removeListener.mockClear()

    server.close()
    expect(sim.removeListener).not.toHaveBeenCalled()
  })
})
