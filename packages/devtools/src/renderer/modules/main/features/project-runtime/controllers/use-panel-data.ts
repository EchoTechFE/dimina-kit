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
  SimulatorElementChannel,
  SimulatorStorageChannel,
  BridgeChannel,
  type ElementInspection,
  type StorageEvent,
  type StorageItem as StorageItemDto,
  type StorageWriteResult,
} from '../../../../../../shared/ipc-channels'
import { ATTACH_RETRY_INTERVAL_MS, MAX_ATTACH_RETRIES } from '../../../../../../preload/shared/constants'
import type { WxmlNode } from '../../right-panel/types.js'
import { asWebview } from './webview-helpers'
import type { CompileStatus, StorageItem } from './use-project-runtime-controller'

export interface UsePanelDataProps {
  compileStatus: CompileStatus
  simulatorRef: RefObject<HTMLElement | null>
}

export interface AppDataBridgeSummary {
  id: string
  pagePath: string | null
}

export interface AppDataState {
  bridges: AppDataBridgeSummary[]
  activeBridgeId: string | null
  entries: Record<string, Record<string, unknown>>
}

const EMPTY_APP_DATA: AppDataState = {
  bridges: [],
  activeBridgeId: null,
  entries: {},
}

export interface PanelDataHookResult {
  connected: boolean
  wxmlTree: WxmlNode | null
  appData: AppDataState
  storageItems: StorageItem[]
  refreshWxml: () => void
  refreshAppData: () => void
  setActiveAppDataBridge: (id: string) => void
  refreshStorage: () => void
  setStorageItem: (key: string, value: string) => Promise<StorageWriteResult>
  removeStorageItem: (key: string) => Promise<StorageWriteResult>
  clearStorage: () => Promise<StorageWriteResult>
  clearAllStorage: () => Promise<StorageWriteResult>
  getStoragePrefix: () => Promise<string>
  inspectWxmlElement: (sid: string) => Promise<ElementInspection | null>
  clearWxmlElementInspection: () => Promise<void>
}

export function usePanelData(props: UsePanelDataProps): PanelDataHookResult {
  const { compileStatus, simulatorRef } = props

  const [connected, setConnected] = useState(true)
  const [wxmlTree, setWxmlTree] = useState<WxmlNode | null>(null)
  const [appData, setAppData] = useState<AppDataState>(EMPTY_APP_DATA)
  const [storageItems, setStorageItems] = useState<StorageItem[]>([])

  const setActiveAppDataBridge = useCallback((id: string) => {
    setAppData((prev) => (
      prev.bridges.some((b) => b.id === id) && prev.activeBridgeId !== id
        ? { ...prev, activeBridgeId: id }
        : prev
    ))
  }, [])

  useEffect(() => {
    if (compileStatus.status !== 'ready') return

    const onIpcMessage = (event: Event) => {
      const { channel, args } = event as Event & { channel: string; args: unknown[] }
      if (channel === SimulatorChannel.Wxml) {
        setWxmlTree(args[0] as WxmlNode)
      } else if (channel === SimulatorChannel.AppData) {
        const payload = args[0] as {
          bridgeId?: string
          moduleId?: string
          componentPath?: string
          data?: unknown
        }
        if (!payload.bridgeId || !payload.moduleId) return
        const { bridgeId, moduleId, componentPath, data } = payload
        const displayKey = componentPath || moduleId
        setAppData((prev) => {
          const known = prev.bridges.find((b) => b.id === bridgeId)
          const isPageInit = moduleId.startsWith('page_') && Boolean(componentPath)
          const nextPagePath = isPageInit ? componentPath ?? null : known?.pagePath ?? null
          const bridges = known
            ? prev.bridges.map((b) => (b.id === bridgeId ? { ...b, pagePath: nextPagePath } : b))
            : [...prev.bridges, { id: bridgeId, pagePath: nextPagePath }]
          const entriesForBridge = { ...(prev.entries[bridgeId] ?? {}), [displayKey]: data }
          const entries = { ...prev.entries, [bridgeId]: entriesForBridge }
          // Auto-switch active tab to the page that just emitted an init so
          // the panel follows the route the user is currently on.
          const activeBridgeId = isPageInit || prev.activeBridgeId === null
            ? bridgeId
            : prev.activeBridgeId
          return { bridges, activeBridgeId, entries }
        })
      } else if (channel === SimulatorChannel.AppDataAll) {
        const snapshot = args[0] as {
          bridges?: AppDataBridgeSummary[]
          entries?: Record<string, Record<string, unknown>>
        } | null
        const bridges = snapshot?.bridges ?? []
        const entries = snapshot?.entries ?? {}
        setAppData((prev) => {
          const stillActive = prev.activeBridgeId && bridges.some((b) => b.id === prev.activeBridgeId)
          const activeBridgeId = stillActive
            ? prev.activeBridgeId
            : (bridges.at(-1)?.id ?? null)
          return { bridges, activeBridgeId, entries }
        })
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
      setAppData(EMPTY_APP_DATA)
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
  // Write helpers — main process forwards CDP-emitted DOMStorage events back
  // through `SimulatorStorageChannel.Event`, so successful writes update the
  // panel via the existing push subscription. No optimistic local state.
  // Main-side `setupSimulatorStorage` lazy-attaches the CDP debugger on the
  // first IPC call, so a user click that lands before the simulator
  // webview's `did-finish-load` no longer silently bounces off
  // `simulator not attached`.
  const setStorageItem = useCallback(async (key: string, value: string) => {
    const r = await ipcInvoke<StorageWriteResult | undefined>(SimulatorStorageChannel.Set, { key, value })
    return r ?? { ok: false, error: 'ipc transport failed' }
  }, [])
  const removeStorageItem = useCallback(async (key: string) => {
    const r = await ipcInvoke<StorageWriteResult | undefined>(SimulatorStorageChannel.Remove, { key })
    return r ?? { ok: false, error: 'ipc transport failed' }
  }, [])
  const clearStorage = useCallback(async () => {
    const r = await ipcInvoke<StorageWriteResult | undefined>(SimulatorStorageChannel.Clear)
    return r ?? { ok: false, error: 'ipc transport failed' }
  }, [])
  const clearAllStorage = useCallback(async () => {
    const r = await ipcInvoke<StorageWriteResult | undefined>(SimulatorStorageChannel.ClearAll)
    return r ?? { ok: false, error: 'ipc transport failed' }
  }, [])
  const getStoragePrefix = useCallback(async () => {
    const r = await ipcInvoke<string | undefined>(SimulatorStorageChannel.GetActivePrefix)
    return r ?? ''
  }, [])
  const inspectWxmlElement = useCallback(async (sid: string) => {
    return await ipcInvoke<ElementInspection | null>(SimulatorElementChannel.Inspect, sid)
  }, [])
  const clearWxmlElementInspection = useCallback(async () => {
    await ipcInvoke<void>(SimulatorElementChannel.Clear)
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
    setActiveAppDataBridge,
    refreshStorage,
    setStorageItem,
    removeStorageItem,
    clearStorage,
    clearAllStorage,
    getStoragePrefix,
    inspectWxmlElement,
    clearWxmlElementInspection,
  }
}
