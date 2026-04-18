import {
  useCallback,
  useEffect,
  useState,
} from 'react'
import type { RefObject } from 'react'
import { onWorkbenchReset } from '@/shared/api'
import { SimulatorChannel, BridgeChannel } from '../../../../../../shared/ipc-channels'
import { applyStorageUpdate } from '@/shared/lib/storage-updates'
import type { WxmlNode } from '../../right-panel/types.js'
import { asWebview } from './webview-helpers'
import type { CompileStatus, StorageItem } from './use-project-runtime-controller'

export interface UsePanelDataProps {
  compileStatus: CompileStatus
  simulatorRef: RefObject<HTMLElement | null>
}

export interface PanelDataHookResult {
  connected: boolean
  wxmlTree: WxmlNode | null
  appData: Record<string, unknown>
  storageItems: StorageItem[]
  refreshWxml: () => void
  refreshAppData: () => void
  refreshStorage: () => void
}

export function usePanelData(props: UsePanelDataProps): PanelDataHookResult {
  const { compileStatus, simulatorRef } = props

  const [connected, setConnected] = useState(true)
  const [wxmlTree, setWxmlTree] = useState<WxmlNode | null>(null)
  const [appData, setAppData] = useState<Record<string, unknown>>({})
  const [storageItems, setStorageItems] = useState<StorageItem[]>([])

  useEffect(() => {
    if (compileStatus.status !== 'ready') return
    const webview = asWebview(simulatorRef)
    if (!webview) return

    const onIpcMessage = (event: Event) => {
      const { channel, args } = event as Event & { channel: string; args: unknown[] }
      if (channel === SimulatorChannel.Wxml) {
        setWxmlTree(args[0] as WxmlNode)
      } else if (channel === SimulatorChannel.AppData) {
        const payload = args[0] as {
          componentPath?: string
          moduleId?: string
          bridgeId?: string
          data?: unknown
        }
        const key = payload.componentPath || payload.moduleId || payload.bridgeId
        if (key) {
          setAppData((prev) => ({ ...prev, [key]: payload.data }))
        }
      } else if (channel === SimulatorChannel.AppDataAll) {
        setAppData(args[0] as Record<string, unknown>)
      } else if (channel === SimulatorChannel.Storage) {
        const msg = args[0] as { action: string; key?: string; value?: string }
        setStorageItems((prev) => applyStorageUpdate(prev, msg))
      } else if (channel === SimulatorChannel.StorageAll) {
        setStorageItems(args[0] as StorageItem[])
      }
    }

    setConnected(true)

    const onCrashed = () => setConnected(false)
    const onLoading = () => setConnected(true)

    webview.addEventListener('ipc-message', onIpcMessage)
    webview.addEventListener('crashed', onCrashed)
    webview.addEventListener('did-start-loading', onLoading)
    return () => {
      webview.removeEventListener('ipc-message', onIpcMessage)
      webview.removeEventListener('crashed', onCrashed)
      webview.removeEventListener('did-start-loading', onLoading)
    }
  }, [compileStatus.status, simulatorRef])

  useEffect(() => {
    return onWorkbenchReset(() => {
      setConnected(true)
      setWxmlTree(null)
      setAppData({})
      setStorageItems([])
    })
  }, [])

  const refreshWxml = useCallback(() => {
    asWebview(simulatorRef)?.send?.(BridgeChannel.WxmlRefreshRequest)
  }, [simulatorRef])
  const refreshAppData = useCallback(() => {
    asWebview(simulatorRef)?.send?.(BridgeChannel.AppDataGetAllRequest)
  }, [simulatorRef])
  const refreshStorage = useCallback(() => {
    asWebview(simulatorRef)?.send?.(BridgeChannel.StorageGetAllRequest)
  }, [simulatorRef])

  return {
    connected,
    wxmlTree,
    appData,
    storageItems,
    refreshWxml,
    refreshAppData,
    refreshStorage,
  }
}
