/**
 * Sidebar/dialog reverse size-advertiser channels — precise-sender-id
 * isolation. Both host-sidebar and host-dialog WCVs load arbitrary
 * downstream host content, so (mirroring HostToolbarAdvertiseHeight, see
 * views.ts's blast-radius comment) their advertise channels are raw
 * `ipcMain.on` listeners gated on the EXACT current wc id — NOT part of the
 * global senderPolicy-gated IpcRegistry. A message whose `event.sender.id`
 * does not match the live sidebar/dialog webContents id must be dropped
 * silently: no state mutation, no throw.
 *
 * Locked contract:
 *  - the current sidebar/dialog wc → the payload reaches
 *    `setHostSidebarWidth` / `reportHostDialogMeasuredExtent`;
 *  - any OTHER sender id (a stale/dead wc, or an unrelated WCV such as the
 *    simulator) → dropped before validation ever runs;
 *  - a malformed payload from the CURRENT wc is also dropped (schema gate),
 *    without throwing — same posture as HostToolbarAdvertiseHeight.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stub = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown
  const handlers = new Map<string, Handler>()
  const listeners = new Map<string, Handler>()
  return {
    handlers,
    listeners,
    ipcMain: {
      handle: vi.fn((channel: string, fn: Handler) => {
        handlers.set(channel, fn)
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel)
      }),
      on: vi.fn((channel: string, fn: Handler) => {
        listeners.set(channel, fn)
      }),
      removeListener: vi.fn((channel: string) => {
        listeners.delete(channel)
      }),
    },
  }
})

vi.mock('electron', () => ({
  ipcMain: stub.ipcMain,
  default: { ipcMain: stub.ipcMain },
}))

import { registerViewsIpc } from './views.js'
import { ViewChannel } from '../../shared/ipc-channels-overlays.js'

const SIDEBAR_WC_ID = 42
const DIALOG_WC_ID = 43

function makeViews() {
  return {
    setPlacementSnapshot: vi.fn(),
    setHostToolbarHeight: vi.fn(),
    getHostToolbarWebContentsId: vi.fn(() => 1),
    getHostToolbarHeight: vi.fn(() => 0),
    getHostSidebarWidth: vi.fn(() => 0),
    setHostSidebarWidth: vi.fn(),
    getHostSidebarWebContentsId: vi.fn(() => SIDEBAR_WC_ID),
    getHostDialogWebContentsId: vi.fn(() => DIALOG_WC_ID),
    reportHostDialogMeasuredExtent: vi.fn(),
  }
}

function makeEvent(senderId: number) {
  return { sender: { id: senderId, isDestroyed: () => false, getURL: () => 'app://stub' } }
}

beforeEach(() => {
  stub.handlers.clear()
  stub.listeners.clear()
  stub.ipcMain.on.mockClear()
  stub.ipcMain.handle.mockClear()
})

describe('view:host-sidebar:advertise-width — precise-sender-id gate', () => {
  it('the live sidebar wc reaches setHostSidebarWidth', () => {
    const views = makeViews()
    const disposable = registerViewsIpc({ views, senderPolicy: undefined } as never)
    const onAdvertiseWidth = stub.listeners.get(ViewChannel.HostSidebarAdvertiseWidth)
    expect(typeof onAdvertiseWidth, `no listener registered on ${ViewChannel.HostSidebarAdvertiseWidth}`).toBe('function')

    onAdvertiseWidth!(makeEvent(SIDEBAR_WC_ID), { axis: 'inline', extent: 240 })

    expect(views.setHostSidebarWidth).toHaveBeenCalledExactlyOnceWith(240)
    disposable.dispose()
  })

  it('a sender id that is not the current sidebar wc is dropped before validation', () => {
    // BUG CAUGHT: without the exact-id gate, ANY webContents (a stale sidebar
    // instance rebuilt after crash, or an unrelated WCV like the simulator)
    // could feed arbitrary width values into the host layout.
    const views = makeViews()
    const disposable = registerViewsIpc({ views, senderPolicy: undefined } as never)
    const onAdvertiseWidth = stub.listeners.get(ViewChannel.HostSidebarAdvertiseWidth)!

    onAdvertiseWidth(makeEvent(SIDEBAR_WC_ID + 1), { axis: 'inline', extent: 240 })

    expect(views.setHostSidebarWidth).not.toHaveBeenCalled()
    disposable.dispose()
  })

  it('a malformed payload from the CURRENT sidebar wc is dropped without throwing', () => {
    const views = makeViews()
    const disposable = registerViewsIpc({ views, senderPolicy: undefined } as never)
    const onAdvertiseWidth = stub.listeners.get(ViewChannel.HostSidebarAdvertiseWidth)!

    for (const badPayload of [{ axis: 'block', extent: 240 }, { axis: 'inline', extent: -1 }, {}, null]) {
      expect(() => onAdvertiseWidth(makeEvent(SIDEBAR_WC_ID), badPayload)).not.toThrow()
    }
    expect(views.setHostSidebarWidth).not.toHaveBeenCalled()
    disposable.dispose()
  })
})

describe('view:host-dialog:advertise-size — precise-sender-id gate', () => {
  it('the live dialog wc reaches reportHostDialogMeasuredExtent for either axis', () => {
    const views = makeViews()
    const disposable = registerViewsIpc({ views, senderPolicy: undefined } as never)
    const onAdvertiseSize = stub.listeners.get(ViewChannel.HostDialogAdvertiseSize)
    expect(typeof onAdvertiseSize, `no listener registered on ${ViewChannel.HostDialogAdvertiseSize}`).toBe('function')

    onAdvertiseSize!(makeEvent(DIALOG_WC_ID), { axis: 'block', extent: 320 })
    onAdvertiseSize!(makeEvent(DIALOG_WC_ID), { axis: 'inline', extent: 480 })

    expect(views.reportHostDialogMeasuredExtent).toHaveBeenNthCalledWith(1, 'block', 320)
    expect(views.reportHostDialogMeasuredExtent).toHaveBeenNthCalledWith(2, 'inline', 480)
    disposable.dispose()
  })

  it('a sender id that is not the current dialog wc is dropped before validation', () => {
    const views = makeViews()
    const disposable = registerViewsIpc({ views, senderPolicy: undefined } as never)
    const onAdvertiseSize = stub.listeners.get(ViewChannel.HostDialogAdvertiseSize)!

    // Cross-slot confusion: the SIDEBAR's own wc id must not be accepted on
    // the dialog channel either — the gate compares against the dialog's id
    // specifically, not "any known host slot".
    onAdvertiseSize(makeEvent(SIDEBAR_WC_ID), { axis: 'block', extent: 320 })

    expect(views.reportHostDialogMeasuredExtent).not.toHaveBeenCalled()
    disposable.dispose()
  })

  it('a malformed payload from the CURRENT dialog wc is dropped without throwing', () => {
    const views = makeViews()
    const disposable = registerViewsIpc({ views, senderPolicy: undefined } as never)
    const onAdvertiseSize = stub.listeners.get(ViewChannel.HostDialogAdvertiseSize)!

    for (const badPayload of [{ axis: 'diagonal', extent: 320 }, { axis: 'block', extent: -1 }, {}, null]) {
      expect(() => onAdvertiseSize(makeEvent(DIALOG_WC_ID), badPayload)).not.toThrow()
    }
    expect(views.reportHostDialogMeasuredExtent).not.toHaveBeenCalled()
    disposable.dispose()
  })
})
