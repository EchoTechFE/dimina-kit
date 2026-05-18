/**
 * Unit tests for `useCustomApiProxy`.
 *
 * The hook bridges the simulator <webview> to ipcMain: it listens for
 * `ipc-message` events on the webview whose channel is the bridge request
 * channel, forwards the request to main via `invokeStrict`, and posts the
 * correlated response back through `webview.send`. These tests pin the
 * forwarding contract — the actual IPC layer and the preload module are
 * mocked out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import type { RefObject } from 'react'

const invokeStrictMock = vi.fn()

vi.mock('@/shared/api/ipc-transport', () => ({
  invoke: vi.fn(),
  invokeStrict: (...args: unknown[]) => invokeStrictMock(...args),
  on: vi.fn(),
}))

import { useCustomApiProxy } from './use-custom-api-proxy'
import {
  SimulatorCustomApiBridgeChannel,
  SimulatorCustomApiChannel,
} from '../../../../../../shared/ipc-channels'

// FakeWebview captures the ipc-message handler so the test can fire events
// against it directly, and exposes `send` as a spy to assert the response.
interface FakeWebview {
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  /** Captured handler set when the hook calls addEventListener('ipc-message'). */
  ipcMessageHandler: ((event: Event) => void) | null
}

function makeFakeWebview(): FakeWebview {
  const wv: FakeWebview = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    send: vi.fn(),
    ipcMessageHandler: null,
  }
  wv.addEventListener.mockImplementation((event: string, handler: (e: Event) => void) => {
    if (event === 'ipc-message') wv.ipcMessageHandler = handler
  })
  return wv
}

function emitIpcMessage(wv: FakeWebview, channel: string, payload: unknown): void {
  expect(wv.ipcMessageHandler).not.toBeNull()
  const event = new Event('ipc-message') as Event & { channel: string; args: unknown[] }
  event.channel = channel
  event.args = [payload]
  wv.ipcMessageHandler!(event)
}

function renderProxyWithWebview(wv: FakeWebview) {
  return renderHook(() => {
    const ref = useRef<HTMLElement | null>(wv as unknown as HTMLElement)
    useCustomApiProxy({
      compileStatus: { status: 'ready', message: '' },
      simulatorRef: ref as RefObject<HTMLElement | null>,
    })
  })
}

beforeEach(() => {
  invokeStrictMock.mockReset()
})

describe('useCustomApiProxy', () => {
  it('forwards `list` requests to ipcMain and posts result back with matching id', async () => {
    invokeStrictMock.mockResolvedValueOnce(['login', 'qd.foo'])
    const wv = makeFakeWebview()
    renderProxyWithWebview(wv)

    emitIpcMessage(wv, SimulatorCustomApiBridgeChannel.Request, { id: 42, op: 'list' })

    await waitFor(() => expect(invokeStrictMock).toHaveBeenCalledWith(SimulatorCustomApiChannel.List))
    await waitFor(() => expect(wv.send).toHaveBeenCalledWith(
      SimulatorCustomApiBridgeChannel.Response,
      { id: 42, result: ['login', 'qd.foo'] },
    ))
  })

  it('forwards `invoke` requests with name + params and propagates the result', async () => {
    invokeStrictMock.mockResolvedValueOnce({ code: 'abc' })
    const wv = makeFakeWebview()
    renderProxyWithWebview(wv)

    emitIpcMessage(wv, SimulatorCustomApiBridgeChannel.Request, {
      id: 7,
      op: 'invoke',
      name: 'login',
      params: { success: 'cb', evtId: 'e1' },
    })

    await waitFor(() => expect(invokeStrictMock).toHaveBeenCalledWith(
      SimulatorCustomApiChannel.Invoke,
      'login',
      { success: 'cb', evtId: 'e1' },
    ))
    await waitFor(() => expect(wv.send).toHaveBeenCalledWith(
      SimulatorCustomApiBridgeChannel.Response,
      { id: 7, result: { code: 'abc' } },
    ))
  })

  it('translates rejections into an error response so the simulator-side Promise rejects', async () => {
    invokeStrictMock.mockRejectedValueOnce(new Error('handler exploded'))
    const wv = makeFakeWebview()
    renderProxyWithWebview(wv)

    emitIpcMessage(wv, SimulatorCustomApiBridgeChannel.Request, {
      id: 9,
      op: 'invoke',
      name: 'login',
      params: null,
    })

    await waitFor(() => expect(wv.send).toHaveBeenCalledWith(
      SimulatorCustomApiBridgeChannel.Response,
      { id: 9, error: 'handler exploded' },
    ))
  })

  it('ignores ipc-message events on unrelated channels', async () => {
    const wv = makeFakeWebview()
    renderProxyWithWebview(wv)

    emitIpcMessage(wv, 'simulator:wxml', { tagName: 'div', attrs: {}, children: [] })

    // Give microtasks a beat — the proxy should never call ipcInvoke for
    // unrelated channels, and the webview's send spy stays untouched.
    await new Promise((r) => setTimeout(r, 5))
    expect(invokeStrictMock).not.toHaveBeenCalled()
    expect(wv.send).not.toHaveBeenCalled()
  })

  it('drops requests with an invalid id (no numeric correlator)', async () => {
    const wv = makeFakeWebview()
    renderProxyWithWebview(wv)

    emitIpcMessage(wv, SimulatorCustomApiBridgeChannel.Request, { id: 'not-a-number', op: 'list' })

    await new Promise((r) => setTimeout(r, 5))
    expect(invokeStrictMock).not.toHaveBeenCalled()
    expect(wv.send).not.toHaveBeenCalled()
  })

  it('does not install a listener until compileStatus.status is "ready"', () => {
    const wv = makeFakeWebview()
    renderHook(() => {
      const ref = useRef<HTMLElement | null>(wv as unknown as HTMLElement)
      useCustomApiProxy({
        compileStatus: { status: 'compiling', message: '' },
        simulatorRef: ref as RefObject<HTMLElement | null>,
      })
    })
    expect(wv.addEventListener).not.toHaveBeenCalled()
  })

  it('removes the listener on unmount so dangling webviews stop receiving events', () => {
    const wv = makeFakeWebview()
    const { unmount } = renderProxyWithWebview(wv)
    expect(wv.addEventListener).toHaveBeenCalledWith('ipc-message', expect.any(Function))
    unmount()
    expect(wv.removeEventListener).toHaveBeenCalledWith('ipc-message', expect.any(Function))
  })
})
