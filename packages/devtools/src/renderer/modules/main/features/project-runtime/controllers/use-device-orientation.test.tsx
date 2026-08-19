/**
 * Guards two orientation contracts in useDevice:
 *  - the session-orientation mirror follows the session main reports as the
 * VISIBLE one (`active`), which the simulator's promotion layer declares.
 * Whoever reported last says nothing about who is on screen: during a soft reload two sessions report, and the outgoing one keeps reporting after the incoming one has taken the screen.
 *  - the FIRST `sendDeviceInfo` push is held back until the read-back of
 * main's persisted orientation resolves, so a ProjectRuntime remount never overwrites main's cache with the local portrait default.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { DEVICES } from '@/shared/constants'

interface OrientationPayload {
  appSessionId: string
  orientation: 'portrait' | 'landscape' | null
  canRotate: boolean
  /** Whether this report comes from the session currently declared visible. */
  active: boolean
}

const { orientationListeners, setNativeDeviceInfo, getNativeDeviceInfo } = vi.hoisted(() => ({
  orientationListeners: [] as Array<(p: OrientationPayload) => void>,
  setNativeDeviceInfo: vi.fn(async () => {}),
  getNativeDeviceInfo: vi.fn(async (): Promise<{ deviceOrientation?: 'portrait' | 'landscape' } | null> => null),
}))

function emitOrientation(payload: OrientationPayload): void {
  for (const fn of [...orientationListeners]) fn(payload)
}

vi.mock('@/shared/api', () => ({
  setNativeDeviceInfo,
  getNativeDeviceInfo,
  onSessionOrientationChanged: vi.fn((handler: (p: OrientationPayload) => void) => {
    orientationListeners.push(handler)
    return () => {
      const i = orientationListeners.indexOf(handler)
      if (i >= 0) orientationListeners.splice(i, 1)
    }
  }),
}))

import { useDevice } from './use-device'

beforeEach(() => {
  orientationListeners.length = 0
  setNativeDeviceInfo.mockClear()
  getNativeDeviceInfo.mockReset()
  getNativeDeviceInfo.mockResolvedValue(null)
})

/**
 * `appOrientation` isn't exposed directly (only `orientedDevice`/`canRotate` are — matching the hook's real public contract), so tests observe the mirror through the panel geometry it drives: DEVICES[1] is 375×812 portrait, so a landscape effective orientation swaps to width>height.
 */
function isLandscape(orientedDevice: { width: number; height: number }): boolean {
  return orientedDevice.width > orientedDevice.height
}

describe('useDevice: the session-orientation mirror follows the declared visible session', () => {
  it('adopts the report of the session that is on screen', async () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEVICES[1]! }))
    await waitFor(() => expect(getNativeDeviceInfo).toHaveBeenCalled())

    act(() => emitOrientation({ appSessionId: 'session-A', orientation: 'landscape', canRotate: false, active: true }))
    expect(isLandscape(result.current.orientedDevice)).toBe(true)
    expect(result.current.canRotate).toBe(false)
  })

  it('ignores a session that is not the one on screen, however loudly it reports', async () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEVICES[1]! }))
    await waitFor(() => expect(getNativeDeviceInfo).toHaveBeenCalled())

    act(() => emitOrientation({ appSessionId: 'session-A', orientation: 'landscape', canRotate: false, active: true }))
    // A soft-reload session boots invisibly and publishes its geometry while session-A still owns the screen.
    act(() => emitOrientation({ appSessionId: 'session-B', orientation: 'portrait', canRotate: true, active: false }))

    expect(isLandscape(result.current.orientedDevice)).toBe(true)
    expect(result.current.canRotate).toBe(false)
  })

  it("ignores the teardown of a session that was already replaced on screen", async () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEVICES[1]! }))
    await waitFor(() => expect(getNativeDeviceInfo).toHaveBeenCalled())

    act(() => emitOrientation({ appSessionId: 'session-A', orientation: 'landscape', canRotate: false, active: true }))
    act(() => emitOrientation({ appSessionId: 'session-B', orientation: null, canRotate: true, active: false }))

    expect(isLandscape(result.current.orientedDevice)).toBe(true)
    expect(result.current.canRotate).toBe(false)
  })

  it("falls back to the device on the visible session's own teardown", async () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEVICES[1]! }))
    await waitFor(() => expect(getNativeDeviceInfo).toHaveBeenCalled())

    act(() => emitOrientation({ appSessionId: 'session-A', orientation: 'landscape', canRotate: false, active: true }))
    act(() => emitOrientation({ appSessionId: 'session-A', orientation: null, canRotate: true, active: true }))

    expect(isLandscape(result.current.orientedDevice)).toBe(false)
    expect(result.current.canRotate).toBe(true)
  })

  it('keeps the promoted session after a hot reload, not the outgoing one that reports last', async () => {
    const { result, rerender } = renderHook(() => useDevice({ initialDevice: DEVICES[1]! }))
    await waitFor(() => expect(getNativeDeviceInfo).toHaveBeenCalled())

    // The outgoing session owns the screen and pins a landscape page.
    act(() => emitOrientation({ appSessionId: 'session-A', orientation: 'landscape', canRotate: false, active: true }))
    expect(isLandscape(result.current.orientedDevice)).toBe(true)

    // A fresh launch round begins.
    // Nothing about it may disturb the mirror — session-A is still the shell the user is looking at.
    rerender()
    expect(
      isLandscape(result.current.orientedDevice),
      'the outgoing session is still on screen while the new one boots',
    ).toBe(true)

    // Pushing the device down to the live session (main re-broadcasts it) makes session-A report again, after the new session already exists.
    act(() => emitOrientation({ appSessionId: 'session-A', orientation: 'landscape', canRotate: false, active: true }))

    // The new session is promoted and republishes its own top page: a portrait page that is still pinned, which no fallback can produce (falling back to the device would leave the rotate control enabled).
    act(() => emitOrientation({ appSessionId: 'session-B', orientation: 'portrait', canRotate: false, active: true }))

    // Only now is the outgoing session disposed — its teardown arrives last.
    act(() => emitOrientation({ appSessionId: 'session-A', orientation: null, canRotate: true, active: false }))

    expect(
      isLandscape(result.current.orientedDevice),
      'the promoted session decides the panel geometry, not whoever spoke last',
    ).toBe(false)
    expect(
      result.current.canRotate,
      'session-B is still being mirrored — its teardown-less predecessor must not have reset the panel to "no session"',
    ).toBe(false)
  })

  it("adopts the promoted session's landscape page even though the outgoing one was portrait", async () => {
    const { result } = renderHook(() => useDevice({ initialDevice: DEVICES[1]! }))
    await waitFor(() => expect(getNativeDeviceInfo).toHaveBeenCalled())

    act(() => emitOrientation({ appSessionId: 'session-A', orientation: 'portrait', canRotate: true, active: true }))
    act(() => emitOrientation({ appSessionId: 'session-B', orientation: 'landscape', canRotate: false, active: false }))
    expect(
      isLandscape(result.current.orientedDevice),
      'the incoming session is still hidden — the panel must not rotate under the visible one',
    ).toBe(false)

    act(() => emitOrientation({ appSessionId: 'session-B', orientation: 'landscape', canRotate: false, active: true }))
    act(() => emitOrientation({ appSessionId: 'session-A', orientation: null, canRotate: true, active: false }))

    expect(isLandscape(result.current.orientedDevice)).toBe(true)
    expect(result.current.canRotate).toBe(false)
  })
})

describe('useDevice: sendDeviceInfo held back until orientation read-back resolves', () => {
  it('queues an early push instead of sending the local portrait default, then flushes with the corrected orientation once read-back resolves', async () => {
    let resolveReadBack!: (v: { deviceOrientation: 'portrait' | 'landscape' } | null) => void
    getNativeDeviceInfo.mockReturnValue(new Promise((resolve) => {
      resolveReadBack = resolve
    }))

    const { result } = renderHook(() => useDevice({ initialDevice: DEVICES[1]! }))

    act(() => {
      result.current.sendDeviceInfo(result.current.device)
    })
    // Read-back hasn't resolved yet — must NOT have pushed anything (that would overwrite main's cache with the still-default portrait value).
    expect(setNativeDeviceInfo).not.toHaveBeenCalled()

    await act(async () => {
      resolveReadBack({ deviceOrientation: 'landscape' })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(setNativeDeviceInfo).toHaveBeenCalledTimes(1)
    expect(setNativeDeviceInfo).toHaveBeenCalledWith(
      expect.objectContaining({ deviceOrientation: 'landscape' }),
    )
    expect(result.current.deviceOrientation).toBe('landscape')
  })

  it('a rotation during the read-back wins — the late persisted value must not undo the click', async () => {
    let resolveReadBack!: (v: { deviceOrientation: 'portrait' | 'landscape' } | null) => void
    getNativeDeviceInfo.mockReturnValue(new Promise((resolve) => {
      resolveReadBack = resolve
    }))

    const { result } = renderHook(() => useDevice({ initialDevice: DEVICES[1]! }))

    // Main still holds portrait and has not answered yet; the user rotates.
    act(() => {
      result.current.handleRotateDevice()
    })
    expect(result.current.deviceOrientation).toBe('landscape')
    expect(setNativeDeviceInfo).not.toHaveBeenCalled()

    await act(async () => {
      resolveReadBack({ deviceOrientation: 'portrait' })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.deviceOrientation).toBe('landscape')
    expect(isLandscape(result.current.orientedDevice)).toBe(true)
    // The queued push flushes with the user's orientation, not main's stale one.
    expect(setNativeDeviceInfo).toHaveBeenCalledTimes(1)
    expect(setNativeDeviceInfo).toHaveBeenCalledWith(
      expect.objectContaining({ deviceOrientation: 'landscape' }),
    )
  })

  it('a call after read-back resolves pushes immediately (the gate never blocks user actions again)', async () => {
    getNativeDeviceInfo.mockResolvedValue(null)
    const { result } = renderHook(() => useDevice({ initialDevice: DEVICES[1]! }))
    await waitFor(() => expect(getNativeDeviceInfo).toHaveBeenCalled())
    // Let the resolved promise's .then() run.
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      result.current.handleRotateDevice()
    })
    expect(setNativeDeviceInfo).toHaveBeenCalledWith(
      expect.objectContaining({ deviceOrientation: 'landscape' }),
    )
  })
  it('a rejected read-back still opens the gate, so rotation keeps working for the rest of the mount', async () => {
    // Main keeps whatever orientation it already had; what must not happen is the gate staying shut, which would silently swallow every later rotation and device switch.
    getNativeDeviceInfo.mockRejectedValue(new Error('invoke failed'))
    const { result } = renderHook(() => useDevice({ initialDevice: DEVICES[1]! }))
    await waitFor(() => expect(getNativeDeviceInfo).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      result.current.handleRotateDevice()
    })
    expect(setNativeDeviceInfo).toHaveBeenCalledWith(
      expect.objectContaining({ deviceOrientation: 'landscape' }),
    )
  })
})
