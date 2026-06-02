import {
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { RefObject } from 'react'
import { attachNativeSimulator, onSimulatorCurrentPage } from '@/shared/api'
import type { AppInfo } from '@/shared/api'
import {
  buildSimulatorUrl,
  getCurrentPagePath,
} from '../../../../../../shared/simulator-route'
import type { CompileConfig } from '@/shared/types'
import type { CompileStatus, DeviceType } from './use-project-runtime-controller'

export interface UseSimulatorProps {
  compileStatus: CompileStatus
  sendDeviceInfo: (device: DeviceType) => void
  simPanelWidthRef: RefObject<number>
  deviceRef: RefObject<DeviceType>
  appInfo: AppInfo | null
  compileConfig: CompileConfig
  port: number
}

export interface SimulatorHookResult {
  simulatorUrl: string
  currentPage: string
}

export function useSimulator(props: UseSimulatorProps): SimulatorHookResult {
  const {
    compileStatus,
    sendDeviceInfo,
    simPanelWidthRef,
    deviceRef,
    appInfo,
    compileConfig,
    port,
  } = props

  const simulatorUrl = useMemo(() => {
    if (!appInfo || !port) return ''
    return buildSimulatorUrl(appInfo.appId, compileConfig, port)
  }, [appInfo, compileConfig, port])

  const [currentPage, setCurrentPage] = useState(() =>
    getCurrentPagePath(simulatorUrl),
  )

  useEffect(() => {
    setCurrentPage(getCurrentPagePath(simulatorUrl))
  }, [simulatorUrl])

  // The page stack lives in the DeviceShell WebContentsView, so in-app
  // navigation never reaches a renderer `<webview>`'s did-navigate events.
  // Subscribe to main's active-page push so the toolbar route stays in sync.
  // Empty path = unknown → keep the URL-seeded value.
  useEffect(() => {
    return onSimulatorCurrentPage((pagePath) => {
      if (pagePath) setCurrentPage(pagePath)
    })
  }, [])

  // ── Mount the simulator as a main-process WebContentsView ───────────────────
  // We ask main to create + load the WCV with the simulatorUrl; main's preload
  // then drives SPAWN → DeviceShell. `currentPage` mirrors the URL (page-stack
  // nav happens inside the WCV and arrives via onSimulatorCurrentPage above).
  useEffect(() => {
    if (compileStatus.status !== 'ready') return
    if (!simulatorUrl) return
    void attachNativeSimulator(simulatorUrl, simPanelWidthRef.current!)
    sendDeviceInfo(deviceRef.current!)
  }, [compileStatus.status, simulatorUrl, simPanelWidthRef, deviceRef, sendDeviceInfo])

  return {
    simulatorUrl,
    currentPage,
  }
}
