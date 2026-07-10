/**
 * setupSimulatorWxml — visibility-gate lifecycle + coalescing edge cases.
 *
 * Split from index.test.ts (which owns registration / pull / push / dispose) to
 * keep each file focused and under the length ratchet. These pin the codex-flagged
 * race fixes: the DOM observer must (re)attach once the render guest exists, an
 * in-flight pull must not push after the panel is hidden/disposed, and events
 * from a non-active app must not drive a spurious walk of the visible page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Electron stub (hoisted so vi.mock factory can reference it) ─────────
const stub = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown
  const ipcHandlers = new Map<string, Handler>()

  const ipcMainStub = {
    handle: vi.fn((channel: string, fn: Handler) => {
      ipcHandlers.set(channel, fn)
    }),
    removeHandler: vi.fn((channel: string) => {
      ipcHandlers.delete(channel)
    }),
  }

  return { ipcHandlers, ipcMainStub }
})

const { ipcHandlers, ipcMainStub } = stub

vi.mock('electron', () => ({
  ipcMain: stub.ipcMainStub,
  app: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { getAllWebContents: vi.fn(() => []) },
  BrowserWindow: class {},
}))

import type { BridgeRouterHandle, RenderEvent } from '../../ipc/bridge-router.js'
import type { RenderInspector } from '../render-inspect/index.js'
import type { WxmlNode } from '@dimina-kit/wxml-inspect'
import { SimulatorWxmlChannel } from '../../../shared/ipc-channels.js'
import { setupSimulatorWxml } from './index.js'

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

function getHandler(channel: string): IpcHandler {
  const fn = ipcHandlers.get(channel)
  if (!fn) throw new Error(`no ipc handler registered for ${channel}`)
  return fn as IpcHandler
}

function makeHost() {
  return {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  } as unknown as Electron.WebContents
}

const FAKE_WC = { id: 42 } as unknown as Electron.WebContents

function makeBridge() {
  const unsubscribe = vi.fn()
  let listener: ((event: RenderEvent) => void) | null = null
  const bridge = {
    isNativeHost: vi.fn(() => true),
    resolveRenderWc: vi.fn(() => null),
    getServiceWc: vi.fn(() => null),
    getServiceWcForBridge: vi.fn(() => null),
    getActiveBridgeId: vi.fn(() => null),
    getActiveRenderWc: vi.fn((_appId?: string) => FAKE_WC as Electron.WebContents | null),
    onRenderEvent: vi.fn((cb: (event: RenderEvent) => void) => {
      listener = cb
      return unsubscribe
    }),
    getDevice: vi.fn(() => null),
    setDevice: vi.fn(),
  } satisfies BridgeRouterHandle
  return {
    bridge,
    unsubscribe,
    fireRenderEvent: (event: RenderEvent) => {
      if (!listener) throw new Error('onRenderEvent listener not captured')
      listener(event)
    },
  }
}

function makeInspector() {
  return {
    getWxml: vi.fn(async () => ({ tagName: 'view', attrs: {}, children: [] })),
    highlight: vi.fn(async () => null),
    unhighlight: vi.fn(async () => {}),
    setWxmlObserving: vi.fn(async () => {}),
  } satisfies RenderInspector
}

beforeEach(() => {
  ipcHandlers.clear()
  ipcMainStub.handle.mockClear()
  ipcMainStub.removeHandler.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('setupSimulatorWxml — deferred observer attach on domReady (bug: observer never attaches if active wc is null at SetActive time)', () => {
  it('attaches the observer once domReady reports the render wc exists, even though it was null at SetActive(true) time', async () => {
    const { bridge, fireRenderEvent } = makeBridge()
    const inspector = makeInspector()
    const host = makeHost()

    // Active wc doesn't exist yet when the panel becomes visible.
    bridge.getActiveRenderWc.mockReturnValueOnce(null)

    const d = setupSimulatorWxml(host, { bridge, inspector, getActiveAppId: () => 'wx123' })

    await getHandler(SimulatorWxmlChannel.SetActive)({}, true)
    // SetActive(true) could not attach — no wc existed yet.
    expect(inspector.setWxmlObserving).not.toHaveBeenCalled()

    // Now the page finishes mounting: domReady fires and the render wc exists
    // (bridge.getActiveRenderWc reverts to its default FAKE_WC mock).
    fireRenderEvent({ kind: 'domReady', appId: 'wx123', bridgeId: 'bridge_1' })

    await vi.waitFor(() => {
      expect(inspector.setWxmlObserving).toHaveBeenCalledWith(FAKE_WC, true)
    })
    void d.dispose()
  })
})

/**
 * Codex-flagged gap: `schedulePull`'s `.then` only checks `mySeq === seq`
 * before pushing — it never re-checks the `active` flag. A pull started while
 * active is in flight, then SetActive(false)/dispose runs (which does NOT
 * bump `seq`), so the stale pull's `.then` still passes the `mySeq === seq`
 * check and calls `host.send` on a now-hidden/torn-down panel.
 */
describe('setupSimulatorWxml — in-flight pull must not push after deactivate/dispose (bug: missing active-flag recheck)', () => {
  it('does not host.send a pull that resolves after SetActive(false) was called mid-flight', async () => {
    const { bridge } = makeBridge()
    const inspector = makeInspector()
    const host = makeHost()

    let resolveWxml!: (v: WxmlNode) => void
    const pending = new Promise<WxmlNode>((resolve) => { resolveWxml = resolve })
    inspector.getWxml.mockImplementation(() => pending as unknown as ReturnType<typeof inspector.getWxml>)

    const d = setupSimulatorWxml(host, { bridge, inspector, getActiveAppId: () => 'wx123' })

    // SetActive(true) seeds a pull; it stays in-flight because getWxml's
    // promise is still pending.
    const activatePromise = getHandler(SimulatorWxmlChannel.SetActive)({}, true)
    await Promise.resolve()

    // Deactivate WHILE the pull is still in flight.
    await getHandler(SimulatorWxmlChannel.SetActive)({}, false)
    await activatePromise

    // Now let the stale pull resolve.
    resolveWxml({ tagName: 'page', attrs: {}, children: [] })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(host.send).not.toHaveBeenCalled()
    void d.dispose()
  })

  it('does not host.send a pull that resolves after dispose() was called mid-flight', async () => {
    const { bridge } = makeBridge()
    const inspector = makeInspector()
    const host = makeHost()

    let resolveWxml!: (v: WxmlNode) => void
    const pending = new Promise<WxmlNode>((resolve) => { resolveWxml = resolve })
    inspector.getWxml.mockImplementation(() => pending as unknown as ReturnType<typeof inspector.getWxml>)

    const d = setupSimulatorWxml(host, { bridge, inspector, getActiveAppId: () => 'wx123' })

    const activatePromise = getHandler(SimulatorWxmlChannel.SetActive)({}, true)
    await Promise.resolve()

    // Dispose WHILE the pull is still in flight.
    await d.dispose()
    await activatePromise

    resolveWxml({ tagName: 'page', attrs: {}, children: [] })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(host.send).not.toHaveBeenCalled()
  })
})

/**
 * Codex-flagged gap: the `onRenderEvent` handler gates on `active` but never
 * checks `event.appId` against the currently-active app — a render event from
 * an app that isn't the one on screen still triggers a full pull + push,
 * wastefully walking (and potentially leaking data from) a background app's
 * tree into the visible panel.
 */
describe('setupSimulatorWxml — render events are filtered by active appId (bug: missing appId check)', () => {
  it('ignores a domMutated event whose appId is not the active app: no pull, no push', async () => {
    const { bridge, fireRenderEvent } = makeBridge()
    const inspector = makeInspector()
    const host = makeHost()
    const d = setupSimulatorWxml(host, { bridge, inspector, getActiveAppId: () => 'wxACTIVE' })

    await getHandler(SimulatorWxmlChannel.SetActive)({}, true)
    await vi.waitFor(() => {
      expect(host.send).toHaveBeenCalled()
    })
    inspector.getWxml.mockClear()
    ;(host.send as ReturnType<typeof vi.fn>).mockClear()

    fireRenderEvent({ kind: 'domMutated', appId: 'wxOTHER', bridgeId: 'bridge_other' })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(inspector.getWxml).not.toHaveBeenCalled()
    expect(host.send).not.toHaveBeenCalled()
    void d.dispose()
  })

  it('still pulls and pushes for a domMutated event whose appId IS the active app', async () => {
    const { bridge, fireRenderEvent } = makeBridge()
    const inspector = makeInspector()
    const tree = { tagName: 'page', attrs: {}, children: [] }
    inspector.getWxml.mockResolvedValue(tree)
    const host = makeHost()
    const d = setupSimulatorWxml(host, { bridge, inspector, getActiveAppId: () => 'wxACTIVE' })

    await getHandler(SimulatorWxmlChannel.SetActive)({}, true)
    await vi.waitFor(() => {
      expect(host.send).toHaveBeenCalled()
    })
    ;(host.send as ReturnType<typeof vi.fn>).mockClear()

    fireRenderEvent({ kind: 'domMutated', appId: 'wxACTIVE', bridgeId: 'bridge_1' })

    await vi.waitFor(() => {
      expect(host.send).toHaveBeenCalledWith(SimulatorWxmlChannel.Event, tree)
    })
    void d.dispose()
  })
})
