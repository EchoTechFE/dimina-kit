import type React from 'react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { RefObject } from 'react'
import { DEVICES } from '@/shared/constants'
import { resizeSimulator } from '@/shared/api'
import {
  clampPanelWidth,
  computeSimPanelWidth,
} from '../lib/device-geometry'
import { asWebview } from './webview-helpers'
import type { DeviceType } from './use-project-runtime-controller'

export interface UseDeviceProps {
  initialDevice: DeviceType
  simulatorRef: RefObject<HTMLElement | null>
}

export interface DeviceHookResult {
  device: DeviceType
  zoom: number
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
   * Defaults to `trailing` for backward compatibility with call sites
   * that haven't switched to the FrameTree renderer yet.
   */
  handleSplitterDrag: (e: React.MouseEvent, side?: 'leading' | 'trailing') => void
  sendDeviceInfo: (device: DeviceType) => void
  simPanelWidthRef: RefObject<number>
  deviceRef: RefObject<DeviceType>
  scheduleResize: (width: number) => void
}

export function useDevice(props: UseDeviceProps): DeviceHookResult {
  const { initialDevice, simulatorRef } = props

  const [device, setDevice] = useState<DeviceType>(initialDevice)
  const [zoom, setZoom] = useState(100)
  const [simPanelWidth, setSimPanelWidth] = useState(() =>
    computeSimPanelWidth(initialDevice.width),
  )
  const resizeFrameRef = useRef<number | null>(null)
  const pendingResizeRef = useRef(simPanelWidth)
  const simPanelWidthRef = useRef(simPanelWidth)
  const deviceRef = useRef(device)

  useEffect(() => {
    pendingResizeRef.current = simPanelWidth
    simPanelWidthRef.current = simPanelWidth
  }, [simPanelWidth])

  useEffect(() => {
    deviceRef.current = device
  }, [device])

  useEffect(() => {
    return () => {
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current)
      }
    }
  }, [])

  const scheduleResize = useCallback((width: number) => {
    pendingResizeRef.current = width
    if (resizeFrameRef.current !== null) return

    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = null
      void resizeSimulator(pendingResizeRef.current)
    })
  }, [])

  const sendDeviceInfo = useCallback((d: DeviceType) => {
    const webview = asWebview(simulatorRef)
    try {
      webview?.send?.('device:change', {
        brand: 'Apple',
        model: d.name,
        pixelRatio: d.pixelRatio,
        screenWidth: d.width,
        screenHeight: d.height,
        statusBarHeight: d.statusBarHeight,
        system: d.system,
        platform: 'ios',
        safeAreaBottom: d.safeAreaBottom,
      })
    } catch {
      // WebView not yet attached to DOM — device info will be sent on dom-ready
    }
  }, [simulatorRef])

  const handleDeviceChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const d = DEVICES.find((item) => item.name === e.target.value) ?? DEVICES[1]!
      setDevice(d)
      sendDeviceInfo(d)
      const newWidth = computeSimPanelWidth(d.width)
      setSimPanelWidth(newWidth)
      scheduleResize(newWidth)
    },
    [scheduleResize, sendDeviceInfo],
  )

  const handleZoomChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setZoom(Number(e.target.value))
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
        const newW = clampPanelWidth(
          startW + signed,
          window.innerWidth,
        )
        setSimPanelWidth(newW)
        scheduleResize(newW)
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [scheduleResize],
  )

  return {
    device,
    zoom,
    simPanelWidth,
    setSimPanelWidth,
    handleDeviceChange,
    handleZoomChange,
    handleSplitterDrag,
    sendDeviceInfo,
    simPanelWidthRef,
    deviceRef,
    scheduleResize,
  }
}
