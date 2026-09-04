/**
 * Who may read the automation port is decided by the window the caller belongs
 * to, not by the window that happens to be active.
 *
 * `AutomationChannel.GetPort` is asked by every renderer that starts an
 * automation client: the project list, and each project window. Gating it on
 * the ACTIVE window's `senderPolicy` means the list window and every
 * background project window are told "sender rejected" — the port is trusted
 * information for all of them, and each one owns its own sender.
 */
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

const stub = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown
  const guardedFns = new Map<string, Handler>()
  const ipcMainStub = {
    handle: vi.fn((channel: string, fn: Handler) => { guardedFns.set(channel, fn) }),
    removeHandler: vi.fn((channel: string) => { guardedFns.delete(channel) }),
    on: vi.fn(),
    removeListener: vi.fn(),
  }
  return { guardedFns, ipcMainStub }
})

vi.mock('electron', () => ({
  ipcMain: stub.ipcMainStub,
  app: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  BrowserWindow: class {},
}))

vi.mock('ws', () => ({
  WebSocketServer: class {
    constructor(_opts: unknown) {
      return {
        on: vi.fn(),
        once: vi.fn((event: string, fn: () => void) => {
          if (event === 'listening') queueMicrotask(() => fn())
        }),
        close: vi.fn(),
        address: vi.fn(() => ({ port: 54321 })),
      } as unknown as InstanceType<typeof WebSocketServer>
    }
  },
}))

import { WebSocketServer } from 'ws'
import { AutomationChannel } from '../../../shared/ipc-channels.js'
import { startAutomationServer } from './index.js'

type CtxStub = ReturnType<Parameters<typeof startAutomationServer>[0]>

/** One window: it trusts its own renderer and nothing else. */
function makeWindowCtx(senderId: number) {
  return {
    senderId,
    senderPolicy: (sender: { id: number }) => sender.id === senderId,
  } as unknown as CtxStub & { senderId: number }
}

const sender = (id: number) => ({ sender: { id, isDestroyed: () => false, getURL: () => `devtools://w${id}` } })

beforeEach(() => {
  stub.guardedFns.clear()
  stub.ipcMainStub.handle.mockClear()
})

describe('the automation port handler with several windows open', () => {
  const listWindow = makeWindowCtx(1)
  const projectA = makeWindowCtx(2)
  const projectB = makeWindowCtx(3)
  /** Stands in for the app's window-context router. */
  const senders = {
    resolve: (s: unknown) => [listWindow, projectA, projectB]
      .find((ctx) => ctx.senderPolicy(s as never)) ?? null,
    list: () => [listWindow, projectA, projectB],
  }

  it('answers a window that is not the active one', async () => {
    // The user is working in project A; the list window asks for the port.
    const server = await startAutomationServer(() => projectA, senders, 0)
    // Closed no matter how the assertions go: the invoke handler is registered
    // process-wide, so a server left open leaks its gate into the next test.
    onTestFinished(() => server.close())
    const guarded = stub.guardedFns.get(AutomationChannel.GetPort)!

    await expect(
      guarded(sender(listWindow.senderId) as unknown as { sender: unknown }),
      'the project list starts automation clients too — rejecting it because another window has focus breaks automation everywhere but the focused project',
    ).resolves.toBe(54321)

    await expect(
      guarded(sender(projectB.senderId) as unknown as { sender: unknown }),
      'a background project window owns its own sender and must be answered from its own policy',
    ).resolves.toBe(54321)
  })

  it('still rejects a sender no window owns', async () => {
    const server = await startAutomationServer(() => projectA, senders, 0)
    onTestFinished(() => server.close())
    const guarded = stub.guardedFns.get(AutomationChannel.GetPort)!

    await expect(
      guarded(sender(99) as unknown as { sender: unknown }),
      'routing by owning window must stay a trust gate: a sender belonging to no window (the simulator webview) still gets nothing',
    ).rejects.toThrow(/sender rejected/i)
  })
})
