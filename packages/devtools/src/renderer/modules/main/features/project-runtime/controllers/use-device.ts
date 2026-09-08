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
} from '@devicekit/devices'
import { frameOuterSize } from '@devicekit/frame'
import { AUTO_ZOOM, type ZoomSetting } from '@/shared/constants'
import { onDevicePickerSelected, setNativeDeviceInfo, showDevicePicker } from '@/shared/api'
import { clampPanelWidth, computeSimPanelWidth } from '../lib/device-geometry'

export type DeviceType = DeviceProfile

export interface UseDeviceProps {
  initialDevice: DeviceType
}

export interface DeviceHookResult {
  device: DeviceType
  zoom: ZoomSetting
  simPanelWidth: number
  setSimPanelWidth: (width: number) => void
  handleDeviceChange: (name: string) => void
  /** Ask main to show the device-picker overlay on the current device. */
  openDevicePicker: () => void
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
  const [zoom, setZoom] = useState<ZoomSetting>(85)
  const [simPanelWidth, setSimPanelWidth] = useState(() =>
    computeSimPanelWidth(frameOuterSize(initialDevice, 'portrait').width),
  )
  const simPanelWidthRef = useRef(simPanelWidth)
  const deviceRef = useRef(device)

  useEffect(() => {
    simPanelWidthRef.current = simPanelWidth
  }, [simPanelWidth])

  useEffect(() => {
    deviceRef.current = device
  }, [device])

  const pushDeviceInfo = useCallback((d: DeviceType) => {
    // The simulator is a main-process WebContentsView, so there is no renderer
    // <webview> to receive `device:change`. The mini-app's authoritative
    // `wx.getSystemInfoSync()` runs in the hidden service-host window off its
    // host-env snapshot; push the device metrics to main, which live-updates
    // that snapshot (no relaunch). Zoom is NOT part of this — it is a display
    // scale applied to the simulator WCV + nested render guests via
    // setNativeSimulatorBounds, so logical device metrics stay zoom-invariant.
    const resolved = resolveDevice(d)
    const orientation = 'portrait'
    const screen = resolved.screen
    void setNativeDeviceInfo({
      device: d.name,
      brand: brandFor(d),
      model: d.name,
      system: resolved.system,
      platform: d.os,
      orientation,
      pixelRatio: d.pixelRatio,
      screenWidth: screen.width,
      screenHeight: screen.height,
      statusBarHeight: statusBarHeightFor(resolved, orientation),
      safeAreaInsets: safeAreaInsetsFor(resolved, orientation),
    })
  }, [])

  const handleDeviceChange = useCallback(
    (name: string) => {
      const d = findDevice(name) ?? DEFAULT_DEVICE
      setDevice(d)
      pushDeviceInfo(d)
      // React layout state is the single width authority: the panel re-renders
      // at the new width, and the simulator/DevTools view anchors re-measure
      // and publish the precise rects to main (no width IPC side-channel).
      setSimPanelWidth(computeSimPanelWidth(frameOuterSize(d, 'portrait').width))
    },
    [pushDeviceInfo],
  )

  // The searchable device picker is an overlay WebContentsView of its own (a
  // DOM dialog in this renderer would be painted over by the simulator's WCV,
  // see view-ids.ts), so opening it is a request to main and the pick comes
  // back as a push. Device state stays owned here: an incoming pick takes the
  // exact same path as one made in this window.
  const openDevicePicker = useCallback(() => {
    showDevicePicker({ deviceName: deviceRef.current.name })
  }, [])

  useEffect(() => {
    return onDevicePickerSelected(({ deviceName }) => handleDeviceChange(deviceName))
  }, [handleDeviceChange])

  // Public single-arg form used by callers outside this hook (e.g. the
  // simulator attach effect, which only knows the device).
  const sendDeviceInfo = useCallback((d: DeviceType) => {
    pushDeviceInfo(d)
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
    zoom,
    simPanelWidth,
    setSimPanelWidth,
    handleDeviceChange,
    openDevicePicker,
    handleZoomChange,
    handleSplitterDrag,
    sendDeviceInfo,
    simPanelWidthRef,
    deviceRef,
  }
}
