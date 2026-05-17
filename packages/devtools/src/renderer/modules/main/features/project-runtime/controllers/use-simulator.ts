import {
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { RefObject } from 'react'
import { attachSimulator, captureThumbnail } from '@/shared/api'
import type { AppInfo } from '@/shared/api'
import {
  buildSimulatorUrl,
  extractCurrentPage,
} from '@/shared/lib/simulator-url'
import type { CompileConfig } from '@/shared/types'
import {
  ATTACH_RETRY_INTERVAL_MS,
  MAX_ATTACH_RETRIES,
} from '../../../../../../preload/shared/constants'
import { asWebview } from './webview-helpers'
import type { CompileStatus, DeviceType } from './use-project-runtime-controller'

export interface UseSimulatorProps {
  compileStatus: CompileStatus
  sendDeviceInfo: (device: DeviceType) => void
  simulatorRef: RefObject<HTMLElement | null>
  simPanelWidthRef: RefObject<number>
  deviceRef: RefObject<DeviceType>
  appInfo: AppInfo | null
  compileConfig: CompileConfig
  port: number
  projectPath: string
}

export interface SimulatorHookResult {
  simulatorUrl: string
  currentPage: string
}

export function useSimulator(props: UseSimulatorProps): SimulatorHookResult {
  const {
    compileStatus,
    sendDeviceInfo,
    simulatorRef,
    simPanelWidthRef,
    deviceRef,
    appInfo,
    compileConfig,
    port,
    projectPath,
  } = props

  const simulatorUrl = useMemo(() => {
    if (!appInfo || !port) return ''
    return buildSimulatorUrl(appInfo.appId, compileConfig, port)
  }, [appInfo, compileConfig, port])

  const [currentPage, setCurrentPage] = useState(() =>
    extractCurrentPage(simulatorUrl),
  )

  useEffect(() => {
    setCurrentPage(extractCurrentPage(simulatorUrl))
  }, [simulatorUrl])

  useEffect(() => {
    if (compileStatus.status !== 'ready') return

    const webview = asWebview(simulatorRef)
    if (!webview) {
      sendDeviceInfo(deviceRef.current!)
      return
    }

    let cancelled = false
    let attached = false
    let attachTimer: number | null = null
    let retryCount = 0

    const syncCurrentPage = (url?: string) => {
      let currentUrl = url
      if (!currentUrl) {
        try { currentUrl = webview.getURL?.() } catch { /* webview not ready */ }
      }
      setCurrentPage(extractCurrentPage(currentUrl ?? simulatorUrl))
    }

    const tryAttach = () => {
      if (cancelled || attached) return
      retryCount++

      if (retryCount > MAX_ATTACH_RETRIES) {
        console.warn('[simulator] Max attach retries exceeded, giving up')
        if (attachTimer !== null) {
          window.clearInterval(attachTimer)
          attachTimer = null
        }
        return
      }

      let simId: number | undefined
      try {
        simId = webview.getWebContentsId?.()
      } catch {
        return
      }
      if (!simId) return
      attached = true
      if (attachTimer !== null) {
        window.clearInterval(attachTimer)
        attachTimer = null
      }
      void attachSimulator(simId, simPanelWidthRef.current!)
      sendDeviceInfo(deviceRef.current!)
      syncCurrentPage()
    }

    const onNavigate = (event: Event) => {
      syncCurrentPage((event as { url?: string }).url)
    }

    const onDomReady = () => {
      if (cancelled) return
      syncCurrentPage()
      sendDeviceInfo(deviceRef.current!)
      tryAttach()
    }

    let captureTimer: number | null = null
    const onFinishLoad = () => {
      if (cancelled) return
      if (captureTimer !== null) window.clearTimeout(captureTimer)
      captureTimer = window.setTimeout(() => {
        if (!cancelled) {
          captureThumbnail(projectPath).catch(() => {})
        }
      }, 3000)
    }

    webview.addEventListener?.('did-navigate', onNavigate as EventListener)
    webview.addEventListener?.('did-navigate-in-page', onNavigate as EventListener)
    webview.addEventListener?.('dom-ready', onDomReady as EventListener)
    webview.addEventListener?.('did-finish-load', onDomReady as EventListener)
    webview.addEventListener?.('did-finish-load', onFinishLoad as EventListener)

    attachTimer = window.setInterval(tryAttach, ATTACH_RETRY_INTERVAL_MS)
    tryAttach()

    return () => {
      cancelled = true
      if (attachTimer !== null) {
        window.clearInterval(attachTimer)
      }
      if (captureTimer !== null) {
        window.clearTimeout(captureTimer)
      }
      webview.removeEventListener?.('did-navigate', onNavigate as EventListener)
      webview.removeEventListener?.('did-navigate-in-page', onNavigate as EventListener)
      webview.removeEventListener?.('dom-ready', onDomReady as EventListener)
      webview.removeEventListener?.('did-finish-load', onDomReady as EventListener)
      webview.removeEventListener?.('did-finish-load', onFinishLoad as EventListener)
    }
  }, [compileStatus.status, sendDeviceInfo, simulatorUrl, simulatorRef, simPanelWidthRef, deviceRef, projectPath])

  return {
    simulatorUrl,
    currentPage,
  }
}
