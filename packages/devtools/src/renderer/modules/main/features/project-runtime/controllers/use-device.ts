import type React from 'react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { RefObject } from 'react'
import {
  DEFAULT_DEVICE,
  findDevice,
  resolveDevice,
  safeAreaInsetsFor,
  statusBarHeightFor,
  type DeviceProfile,
  type Orientation,
} from '@devicekit/devices'
import { frameOuterSize } from '@devicekit/frame'
import { AUTO_ZOOM, type ZoomSetting } from '@/shared/constants'
import { setNativeDeviceInfo } from '@/shared/api'
import { clampPanelWidth, computeSimPanelWidth } from '../lib/device-geometry'

export type DeviceType = DeviceProfile

export interface UseDeviceProps {
  initialDevice: DeviceType
}

export interface DeviceHookResult {
  device: DeviceType
  orientation: Orientation
  zoom: ZoomSetting
  simPanelWidth: number
  setSimPanelWidth: (width: number) => void
  handleDeviceChange: (name: string) => void
  handleOrientationChange: (orientation: Orientation) => void
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

/**
 * Brand shown in the mini-app's `wx.getSystemInfoSync()` payload. The device
 * table carries no brand field (many entries share a maker), so it is derived
 * from platform + name: iOS is always Apple; Android's first name word is the
 * maker (WeChat's own devtools does the same); HarmonyOS devices are all
 * Huawei today.
 */
function brandFor(device: DeviceProfile): string {
  if (device.os === 'ios') return 'Apple'
  if (device.os === 'harmony') return 'HUAWEI'
  return device.name.split(' ')[0] ?? device.name
}

export function useDevice(props: UseDeviceProps): DeviceHookResult {
  const { initialDevice } = props

  const [device, setDevice] = useState<DeviceType>(initialDevice)
  const [orientation, setOrientation] = useState<Orientation>('portrait')
  const [zoom, setZoom] = useState<ZoomSetting>(85)
  const [simPanelWidth, setSimPanelWidth] = useState(() =>
    computeSimPanelWidth(frameOuterSize(initialDevice, 'portrait').width),
  )
  const simPanelWidthRef = useRef(simPanelWidth)
  const deviceRef = useRef(device)
  const orientationRef = useRef(orientation)

  useEffect(() => {
    simPanelWidthRef.current = simPanelWidth
  }, [simPanelWidth])

  useEffect(() => {
    deviceRef.current = device
  }, [device])

  useEffect(() => {
    orientationRef.current = orientation
  }, [orientation])

  const pushDeviceInfo = useCallback((d: DeviceType, o: Orientation) => {
    // The simulator is a main-process WebContentsView, so there is no renderer
    // <webview> to receive `device:change`. The mini-app's authoritative
    // `wx.getSystemInfoSync()` runs in the hidden service-host window off its
    // host-env snapshot; push the device metrics to main, which live-updates
    // that snapshot (no relaunch). Zoom is NOT part of this — it is a display
    // scale applied to the simulator WCV + nested render guests via
    // setNativeSimulatorBounds, so logical device metrics stay zoom-invariant.
    const resolved = resolveDevice(d)
    const screen = o === 'landscape'
      ? { width: resolved.screen.height, height: resolved.screen.width }
      : resolved.screen
    void setNativeDeviceInfo({
      device: d.name,
      brand: brandFor(d),
      model: d.name,
      system: resolved.system,
      platform: d.os,
      orientation: o,
      pixelRatio: d.pixelRatio,
      screenWidth: screen.width,
      screenHeight: screen.height,
      statusBarHeight: statusBarHeightFor(resolved, o),
      safeAreaInsets: safeAreaInsetsFor(resolved, o),
    })
  }, [])

  const handleDeviceChange = useCallback(
    (name: string) => {
      const d = findDevice(name) ?? DEFAULT_DEVICE
      setDevice(d)
      pushDeviceInfo(d, orientation)
      // React layout state is the single width authority: the panel re-renders
      // at the new width, and the simulator/DevTools view anchors re-measure
      // and publish the precise rects to main (no width IPC side-channel).
      setSimPanelWidth(computeSimPanelWidth(frameOuterSize(d, orientation).width))
    },
    [orientation, pushDeviceInfo],
  )

  const handleOrientationChange = useCallback(
    (o: Orientation) => {
      setOrientation(o)
      pushDeviceInfo(device, o)
      setSimPanelWidth(computeSimPanelWidth(frameOuterSize(device, o).width))
    },
    [device, pushDeviceInfo],
  )

  // Public single-arg form used by callers outside this hook (e.g. the
  // simulator attach effect, which only knows the device — orientation is
  // this hook's own state, read from the ref so the callback identity stays
  // stable across orientation changes).
  const sendDeviceInfo = useCallback((d: DeviceType) => {
    pushDeviceInfo(d, orientationRef.current)
  }, [pushDeviceInfo])

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
    orientation,
    zoom,
    simPanelWidth,
    setSimPanelWidth,
    handleDeviceChange,
    handleOrientationChange,
    handleZoomChange,
    handleSplitterDrag,
    sendDeviceInfo,
    simPanelWidthRef,
    deviceRef,
  }
}
