import {
  useCallback,
  useEffect,
  useState,
} from 'react'
import type { RefObject } from 'react'
import { onWorkbenchReset } from '@/shared/api'
import { invoke as ipcInvoke, on as ipcOn } from '@/shared/api/ipc-transport'
import {
  SimulatorChannel,
  SimulatorStorageChannel,
  BridgeChannel,
  type StorageEvent,
  type StorageItem as StorageItemDto,
} from '../../../../../../shared/ipc-channels'
import { ATTACH_RETRY_INTERVAL_MS, MAX_ATTACH_RETRIES } from '../../../../../../preload/shared/constants'
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
      }
    }

    const onCrashed = () => setConnected(false)
    const onLoading = () => setConnected(true)

    // The <webview> element mounts conditionally on `preloadPath && simulatorUrl`,
    // both resolved asynchronously by useSession. compileStatus can flip to
    // 'ready' BEFORE preloadPath resolves, in which case `simulatorRef.current`
    // is still null when this effect first runs and the IPC listener is never
    // installed (the effect doesn't re-run because the ref identity is stable).
    // Use a bounded retry loop (same constants as preload's tryAttach) to
    // bind once the webview is mounted; otherwise simulator:storage-all/
    // wxml/appdata events arrive at the webview but never reach React state.
    let attached: HTMLElement | null = null
    let pollTimer: number | null = null
    let attempts = 0

    const tryAttach = () => {
      if (attached) return
      const webview = asWebview(simulatorRef)
      if (!webview) {
        attempts += 1
        if (attempts >= MAX_ATTACH_RETRIES && pollTimer !== null) {
          window.clearInterval(pollTimer)
          pollTimer = null
        }
        return
      }
      attached = webview
      if (pollTimer !== null) {
        window.clearInterval(pollTimer)
        pollTimer = null
      }
      setConnected(true)
      webview.addEventListener('ipc-message', onIpcMessage)
      webview.addEventListener('crashed', onCrashed)
      webview.addEventListener('did-start-loading', onLoading)
    }

    tryAttach()
    if (!attached) {
      pollTimer = window.setInterval(tryAttach, ATTACH_RETRY_INTERVAL_MS)
    }

    return () => {
      if (pollTimer !== null) {
        window.clearInterval(pollTimer)
        pollTimer = null
      }
      if (attached) {
        attached.removeEventListener('ipc-message', onIpcMessage)
        attached.removeEventListener('crashed', onCrashed)
        attached.removeEventListener('did-start-loading', onLoading)
      }
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
  const refreshStorage = useCallback(async () => {
    const items = await ipcInvoke<StorageItemDto[] | undefined>(SimulatorStorageChannel.GetSnapshot)
    if (items) setStorageItems(items)
  }, [])

  // Subscribe to live storage events forwarded by the main-process CDP
  // listener. Push events keep the panel reactive without polling; the
  // refresh button still hits GetSnapshot for a full reload.
  useEffect(() => {
    return ipcOn<[StorageEvent]>(SimulatorStorageChannel.Event, (evt) => {
      if (evt.type === 'cleared') {
        setStorageItems([])
      } else if (evt.type === 'added' || evt.type === 'updated') {
        setStorageItems((prev) => {
          const idx = prev.findIndex((it) => it.key === evt.key)
          const next = idx >= 0 ? [...prev] : [...prev, { key: evt.key, value: evt.newValue }]
          if (idx >= 0) next[idx] = { key: evt.key, value: evt.newValue }
          return next
        })
      } else if (evt.type === 'removed') {
        setStorageItems((prev) => prev.filter((it) => it.key !== evt.key))
      }
    })
  }, [])

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
