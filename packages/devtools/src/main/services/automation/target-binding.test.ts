/**
 * Which project window a single automation connection acts on.
 *
 * A script connects, drives one project, and must keep driving THAT project:
 * the window the user happens to be looking at is not part of the protocol.
 * These tests pin the user-visible half of that — where a command lands, where
 * the console it receives comes from, and what happens once the window it was
 * driving is gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  app: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  BrowserWindow: class {},
}))

// ws stub: emulate the WebSocketServer surface used by startAutomationServer.
const wssStub = vi.hoisted(() => {
  const created: Array<{ emit: (event: string, ...args: unknown[]) => void }> = []
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

vi.mock('ws', () => ({ WebSocketServer: wssStub.WebSocketServerStub }))

// Import AFTER the mocks so the module picks up the stubs.
import { createConnectionRegistry } from '@dimina-kit/electron-deck/main'
import { SimulatorChannel } from '../../../shared/ipc-channels.js'
import { startAutomationServer } from './index.js'
import { getSimulator } from './exec.js'

vi.mock('./exec.js', async () => {
  const actual = await vi.importActual<typeof import('./exec.js')>('./exec.js')
  return { ...actual, getSimulator: vi.fn() }
})

const getSimulatorMock = vi.mocked(getSimulator)

type CtxStub = ReturnType<Parameters<typeof startAutomationServer>[0]>

interface CtxHarness {
  ctx: CtxStub
  window: { isDestroyed: ReturnType<typeof vi.fn> }
  closeProject: ReturnType<typeof vi.fn>
}

/**
 * `Tool.close` is a registered handler that only touches `ctx.workspace`, so a
 * per-context `closeProject` spy shows WHICH window a message actually reached.
 */
function makeCtx(hasSession = true): CtxHarness {
  const window = { isDestroyed: vi.fn(() => false) }
  const closeProject = vi.fn(async () => {})
  const raw = {
    senderPolicy: () => true,
    connections: createConnectionRegistry(),
    windows: { mainWindow: window },
    workspace: { hasActiveSession: () => hasSession, closeProject },
  }
  return { ctx: raw as unknown as CtxStub, window, closeProject }
}

let nextSimId = 1
function makeSim() {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>()
  return {
    id: nextSimId++,
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
    log: (text: string) => {
      for (const fn of [...(listeners.get('ipc-message-host') ?? [])]) {
        fn({}, SimulatorChannel.Console, { level: 'log', args: [text] })
      }
    },
  }
}

type SimStub = ReturnType<typeof makeSim>

/** Route `getSimulator(ctx)` per context, the way separate windows do. */
const simOf = new Map<CtxStub, SimStub | null>()

function makeClient() {
  const send = vi.fn()
  const on = vi.fn()
  const ws = { readyState: 1, OPEN: 1, send, close: vi.fn(), on }
  return {
    ws,
    send,
    message: (method: string, id = '1') => {
      const listener = on.mock.calls.find(([event]) => event === 'message')?.[1] as
        (raw: string) => Promise<void>
      return listener(JSON.stringify({ id, method, params: {} }))
    },
    responses: () =>
      send.mock.calls
        .map(([raw]) => JSON.parse(String(raw)) as { id?: string; error?: { message: string } })
        .filter((m) => m.id !== undefined),
    logs: () =>
      send.mock.calls
        .map(([raw]) => JSON.parse(String(raw)) as { method?: string; params?: { args?: unknown[] } })
        .filter((m) => m.method === 'App.logAdded')
        .flatMap((m) => (m.params?.args ?? []) as unknown[]),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  wssStub.created.length = 0
  simOf.clear()
  getSimulatorMock.mockReset()
  getSimulatorMock.mockImplementation(
    (ctx) => (simOf.get(ctx as unknown as CtxStub) ?? null) as ReturnType<typeof getSimulator>,
  )
})

afterEach(() => {
  vi.useRealTimers()
})

describe('automation connection target', () => {
  it('keeps driving the project it reached when another project window takes focus', async () => {
    const a = makeCtx()
    const b = makeCtx()
    let active = a.ctx
    const server = await startAutomationServer(() => active, { resolve: () => active, list: () => [active] }, 0)

    const client = makeClient()
    wssStub.created[0]!.emit('connection', client.ws)
    await client.message('Tool.close')
    expect(a.closeProject).toHaveBeenCalledTimes(1)

    // The user clicks the other project's window; the script did nothing.
    active = b.ctx
    await client.message('Tool.close', '2')

    expect(b.closeProject, 'window focus must not redirect a live connection').not.toHaveBeenCalled()
    expect(a.closeProject).toHaveBeenCalledTimes(2)

    server.close()
  })

  it('forwards console from the same window its commands reach', async () => {
    const a = makeCtx()
    const b = makeCtx()
    const simA = makeSim()
    const simB = makeSim()
    simOf.set(a.ctx, simA)
    simOf.set(b.ctx, simB)
    let active = a.ctx
    const server = await startAutomationServer(() => active, { resolve: () => active, list: () => [active] }, 0)

    const client = makeClient()
    wssStub.created[0]!.emit('connection', client.ws)
    await client.message('Tool.close')

    active = b.ctx
    await vi.advanceTimersByTimeAsync(1000)
    await client.message('Tool.close', '2')

    simA.log('from-a')
    simB.log('from-b')

    expect(client.logs(), 'console must come from the window the commands reach').toContain('from-a')
    expect(client.logs()).not.toContain('from-b')
    expect(b.closeProject).not.toHaveBeenCalled()

    server.close()
  })

  it('binds to the first project window that opens when the client connected before one existed', async () => {
    const list = makeCtx(false)
    const a = makeCtx()
    const b = makeCtx()
    let active: CtxStub = list.ctx
    const server = await startAutomationServer(() => active, { resolve: () => active, list: () => [active] }, 0)

    // Connecting at boot must work: nothing to drive yet, but no error either.
    const client = makeClient()
    wssStub.created[0]!.emit('connection', client.ws)
    await client.message('Tool.getInfo')
    expect(client.responses()[0]?.error).toBeUndefined()

    // The script opens a project; the first window with a session becomes its target.
    active = a.ctx
    await client.message('Tool.close', '2')
    expect(a.closeProject).toHaveBeenCalledTimes(1)

    active = b.ctx
    await client.message('Tool.close', '3')
    expect(a.closeProject).toHaveBeenCalledTimes(2)
    expect(b.closeProject).not.toHaveBeenCalled()

    server.close()
  })

  it('fails the command instead of drifting once its window is closed', async () => {
    const a = makeCtx()
    const b = makeCtx()
    let active = a.ctx
    const server = await startAutomationServer(() => active, { resolve: () => active, list: () => [active] }, 0)

    const client = makeClient()
    wssStub.created[0]!.emit('connection', client.ws)
    await client.message('Tool.close')

    // The user closes the window the script was driving; another project stays open.
    a.window.isDestroyed.mockReturnValue(true)
    active = b.ctx
    await client.message('Tool.close', '2')

    const last = client.responses().at(-1)!
    expect(last.error?.message, 'a closed target must be reported, not replaced').toMatch(/closed/i)
    expect(b.closeProject, 'a closed target must not fall through to another project').not.toHaveBeenCalled()

    server.close()
  })

  it('follows its own window when the simulator is replaced by a rebuild', async () => {
    const a = makeCtx()
    const first = makeSim()
    const rebuilt = makeSim()
    simOf.set(a.ctx, first)
    const server = await startAutomationServer(() => a.ctx, a.ctx, 0)

    const client = makeClient()
    wssStub.created[0]!.emit('connection', client.ws)
    await vi.advanceTimersByTimeAsync(1000)
    first.log('before-rebuild')

    // A rebuild swaps the window's simulator webContents.
    simOf.set(a.ctx, rebuilt)
    await vi.advanceTimersByTimeAsync(1000)
    rebuilt.log('after-rebuild')
    first.log('stale')

    expect(client.logs()).toContain('before-rebuild')
    expect(client.logs(), 'console must re-point at the replacement simulator').toContain('after-rebuild')
    expect(client.logs(), 'the replaced simulator must be detached').not.toContain('stale')

    server.close()
  })
})
