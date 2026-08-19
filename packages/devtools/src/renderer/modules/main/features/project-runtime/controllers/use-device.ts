import type React from 'react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { RefObject } from 'react'
import type { Orientation } from '@dimina-kit/electron-runtime/shared/page-orientation'
import { AUTO_ZOOM, DEVICES, type ZoomSetting } from '@/shared/constants'
import { getNativeDeviceInfo, onSessionOrientationChanged, setNativeDeviceInfo } from '@/shared/api'
import {
  clampPanelWidth,
  computeSimPanelWidth,
  orientedDeviceSize,
} from '../lib/device-geometry'
import type { DeviceType } from './use-project-runtime-controller'

export interface UseDeviceProps {
  initialDevice: DeviceType
}

export interface DeviceHookResult {
  device: DeviceType
  zoom: ZoomSetting
  /**
   * The simulated device's own orientation — user-controlled via the rotate button, persists across mini-app sessions (device switches, relaunches), and is never written back to by the mini-app itself.
   * See shared/page-orientation.ts for how it combines with a page's own orientation config into what's actually shown.
   */
  deviceOrientation: Orientation
  handleRotateDevice: () => void
  /** Whether the rotate control should be enabled — false while the active session's top page is pinned to a fixed orientation. True with no session. */
  canRotate: boolean
  /** `device` sized at the currently-displayed orientation (`appOrientation ?? deviceOrientation`) — what SimulatorPanel should render at. */
  orientedDevice: { name: string; width: number; height: number }
  simPanelWidth: number
  setSimPanelWidth: (width: number) => void
  handleDeviceChange: (e: React.ChangeEvent<HTMLSelectElement>) => void
  handleZoomChange: (e: React.ChangeEvent<HTMLSelectElement>) => void
  /**
   * Manual splitter drag handler for the sim column. `side` describes
   * which side of the sim column the splitter is rendered on:
   *   - `trailing` (default): splitter is to the RIGHT of the sim
   *     column (alignment=left). Dragging right widens the column —
   *     `delta = ev.clientX - startX` is the natural width delta.
   *   - `leading`: splitter is to the LEFT of the sim column
   *     (alignment=right). Dragging left widens the column — the delta
   *     sign must be inverted.
   *
   * Defaults to `trailing`. (The dock layout resizes via
   * react-resizable-panels, so this manual splitter handler is retained on the
   * controller for embedders but is no longer wired into the project window.)
   */
  handleSplitterDrag: (e: React.MouseEvent, side?: 'leading' | 'trailing') => void
  sendDeviceInfo: (device: DeviceType) => void
  simPanelWidthRef: RefObject<number>
  deviceRef: RefObject<DeviceType>
}

export function useDevice(props: UseDeviceProps): DeviceHookResult {
  const { initialDevice } = props

  const [device, setDevice] = useState<DeviceType>(initialDevice)
  const [zoom, setZoom] = useState<ZoomSetting>(85)
  // Persists across device switches / relaunches within THIS mount — only the rotate button changes it, never a mini-app or a device swap.
  // Defaults to portrait until the read-back below (main/ipc/simulator.ts's GetDeviceInfo, returning ctx.bridge.getDevice()) resolves and corrects it — see `orientationReadyRef` for how the FIRST `sendDeviceInfo` push is held back so this local default is never the one that overwrites main's cache.
  const [deviceOrientation, setDeviceOrientation] = useState<Orientation>('portrait')
  const deviceOrientationRef = useRef(deviceOrientation)
  // The active session's forced orientation (main's translation of the top page's effective orientation), or null with no session — see shared/page-orientation.ts: this is a MIRROR only, device-shell remains the sole authority that computes it.
  const [appOrientation, setAppOrientation] = useState<Orientation | null>(null)
  const [canRotate, setCanRotate] = useState(true)
  const effectiveOrientation = appOrientation ?? deviceOrientation
  const [simPanelWidth, setSimPanelWidth] = useState(() =>
    computeSimPanelWidth(initialDevice.width),
  )
  const simPanelWidthRef = useRef(simPanelWidth)
  const deviceRef = useRef(device)
  // Gates the FIRST `sendDeviceInfo` push: while false, `sendDeviceInfo` only records `d` in `pendingDeviceRef` instead of pushing it, so a mount-time caller (use-simulator.ts pushes the device before every attach) can never overwrite main's persisted orientation with the local portrait default — main's cache is the one that's still correct, untouched, for as long as this gate holds.
  // Read-back and any subsequent push are independent of this gate once it flips true (never blocks user actions again).
  const orientationReadyRef = useRef(false)
  const pendingDeviceRef = useRef<DeviceType | null>(null)
  // Counts user rotations.
  // The read-back below stamps this when it starts and adopts main's persisted orientation only if the stamp still matches on arrival: a rotation that happens while the read is in flight is the newer intent, and letting the older value land would silently undo the click.
  const orientationMutationRef = useRef(0)
  useEffect(() => {
    simPanelWidthRef.current = simPanelWidth
  }, [simPanelWidth])

  useEffect(() => {
    deviceRef.current = device
  }, [device])

  // This panel shows one phone, so it mirrors exactly one session: the one the simulator declared as being on screen, which main marks with `active`.
  // Every other report belongs to a shell the user cannot see — a soft-reload session booting behind the live one, or the outgoing session still reporting (and finally tearing down) after the swap — and moving the panel for any of them would rotate it under the mini-app actually on screen.
  useEffect(() => onSessionOrientationChanged((payload) => {
    if (!payload.active) return
    // `orientation: null` means the session on screen forces nothing (its top page is `auto`) or has just ended: both fall back to the device's own orientation, which is what a null `appOrientation` renders.
    setAppOrientation(payload.orientation)
    setCanRotate(payload.canRotate)
  }), [])

  // The actual IPC push, factored out so both `sendDeviceInfo` and the gate-flush below (once the orientation read-back resolves) share it.
  const pushDeviceInfo = useCallback((d: DeviceType) => {
    // The simulator is a main-process WebContentsView, so there is no renderer
    // <webview> to receive `device:change`. The mini-app's authoritative
    // `wx.getSystemInfoSync()` runs in the hidden service-host window off its
    // host-env snapshot; push the device metrics to main, which live-updates
    // that snapshot (no relaunch). Zoom is NOT part of this — it is a display
    // scale applied to the simulator WCV + nested render guests via
    // setNativeSimulatorBounds, so logical device metrics stay zoom-invariant.
    void setNativeDeviceInfo({
      brand: 'Apple',
      model: d.name,
      system: d.system,
      platform: 'ios',
      pixelRatio: d.pixelRatio,
      screenWidth: d.width,
      screenHeight: d.height,
      statusBarHeight: d.statusBarHeight,
      notchType: d.notchType,
      safeAreaInsets: { ...d.safeAreaInsets },
      deviceOrientation: deviceOrientationRef.current,
    })
  }, [])

  const sendDeviceInfo = useCallback((d: DeviceType) => {
    if (!orientationReadyRef.current) {
      // Queue instead of pushing now — main already holds the correct orientation from before this mount; pushing the local portrait default here would overwrite it with the wrong value.
      // The read-back effect flushes this (with the corrected `deviceOrientationRef`) the moment it resolves.
      pendingDeviceRef.current = d
      return
    }
    pushDeviceInfo(d)
  }, [pushDeviceInfo])

  // One-shot read-back of the orientation main already holds (persists across this window's ProjectRuntime mounts — main/ipc/simulator.ts's GetDeviceInfo, `ctx.bridge.getDevice()`).
  // Runs once per mount; opens the `sendDeviceInfo` gate and flushes whatever queued while it was closed.
  useEffect(() => {
    let cancelled = false
    const issuedAt = orientationMutationRef.current
    const openGate = () => {
      orientationReadyRef.current = true
      const pending = pendingDeviceRef.current
      pendingDeviceRef.current = null
      if (pending) pushDeviceInfo(pending)
    }
    void getNativeDeviceInfo().then((info) => {
      if (cancelled) return
      // Skipped when the user rotated while this was in flight — the queued push below then flushes the user's orientation, not the stale one.
      if (info?.deviceOrientation && orientationMutationRef.current === issuedAt) {
        deviceOrientationRef.current = info.deviceOrientation
        setDeviceOrientation(info.deviceOrientation)
      }
      openGate()
    }).catch(() => {
      // A failed read-back leaves main's orientation as the better value, but the gate must still open: leaving it shut would silently drop every device switch and rotation for the rest of this mount.
      if (!cancelled) openGate()
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleDeviceChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const d = DEVICES.find((item) => item.name === e.target.value) ?? DEVICES[1]!
      setDevice(d)
      sendDeviceInfo(d)
      // React layout state is the single width authority: the panel re-renders
      // at the new width, and the simulator/DevTools view anchors re-measure
      // and publish the precise rects to main (no width IPC side-channel).
      // Sized at the currently-DISPLAYED orientation, not the device's raw portrait width — switching device model mid-landscape-session must not snap the panel back to a portrait width.
      setSimPanelWidth(computeSimPanelWidth(orientedDeviceSize(d, effectiveOrientation).width))
    },
    [sendDeviceInfo, effectiveOrientation],
  )

  const handleRotateDevice = useCallback(() => {
    const next: Orientation = deviceOrientationRef.current === 'portrait' ? 'landscape' : 'portrait'
    orientationMutationRef.current += 1
    deviceOrientationRef.current = next
    setDeviceOrientation(next)
    sendDeviceInfo(deviceRef.current)
  }, [sendDeviceInfo])

  const handleZoomChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setZoom(e.target.value === AUTO_ZOOM ? AUTO_ZOOM : (Number(e.target.value) as ZoomSetting))
    },
    [],
  )

  const handleSplitterDrag = useCallback(
    (e: React.MouseEvent, side: 'leading' | 'trailing' = 'trailing') => {
      e.preventDefault()
      const startX = e.clientX
      const startW = simPanelWidthRef.current
      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX
        // `trailing` splitter (default): drag right widens the column.
        // `leading` splitter (sim column on the right, alignment=right):
        // drag left widens it — invert the delta so user intent matches
        // the resulting width change.
        const signed = side === 'trailing' ? delta : -delta
        setSimPanelWidth(clampPanelWidth(
          startW + signed,
          window.innerWidth,
        ))
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [],
  )

  return {
    device,
    zoom,
    deviceOrientation,
    handleRotateDevice,
    canRotate,
    orientedDevice: { name: device.name, ...orientedDeviceSize(device, effectiveOrientation) },
    simPanelWidth,
    setSimPanelWidth,
    handleDeviceChange,
    handleZoomChange,
    handleSplitterDrag,
    sendDeviceInfo,
    simPanelWidthRef,
    deviceRef,
  }
}
