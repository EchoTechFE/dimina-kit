import {
  useCallback,
  useEffect,
  useState,
} from 'react'
import { useActiveBridgeId } from './use-active-bridge-id'
import { invoke as ipcInvoke, on as ipcOn } from '@/shared/api/ipc-transport'
import {
  SimulatorAppDataChannel,
  SimulatorElementChannel,
  SimulatorStorageChannel,
  SimulatorWxmlChannel,
  type ElementInspection,
  type StorageEvent,
  type StorageItem as StorageItemDto,
  type StorageWriteResult,
} from '../../../../../../shared/ipc-channels'
import type { AppDataSnapshot } from '../../../../../../preload/instrumentation/app-data'
import type { WxmlNode } from '../../right-panel/types.js'
import { useNativeChannelSnapshot } from './use-native-channel-snapshot'
import type { CompileStatus, StorageItem } from './use-project-runtime-controller'

export interface UsePanelDataProps {
  compileStatus: CompileStatus
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

const EMPTY_APP_DATA_SNAPSHOT: AppDataSnapshot = {
  bridges: [],
  entries: {},
}

export interface PanelDataHookResult {
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
  const { compileStatus } = props

  const [storageItems, setStorageItems] = useState<StorageItem[]>([])

  const ready = compileStatus.status === 'ready'

  // The page DOM lives in render-host <webview> guests and the service logic in
  // the hidden service-host window — neither reachable from the simulator
  // preload — so WXML + AppData are sourced from the main process
  // (simulator-wxml / simulator-appdata services) over dedicated channels:
  // seed via GetSnapshot + live updates via Event.
  const nativeWxml = useNativeChannelSnapshot<WxmlNode | null>({
    getChannel: SimulatorWxmlChannel.GetSnapshot,
    eventChannel: SimulatorWxmlChannel.Event,
    initial: null,
    enabled: ready,
  })

  const nativeAppData = useNativeChannelSnapshot<AppDataSnapshot>({
    getChannel: SimulatorAppDataChannel.GetSnapshot,
    eventChannel: SimulatorAppDataChannel.Event,
    initial: EMPTY_APP_DATA_SNAPSHOT,
    enabled: ready,
  })
  const appDataData = nativeAppData.data

  const { activeBridgeId, setActiveBridge } = useActiveBridgeId(appDataData.bridges)

  const appData: AppDataState = {
    bridges: appDataData.bridges,
    activeBridgeId,
    entries: appDataData.entries,
  }

  const setActiveAppDataBridge = setActiveBridge

  const refreshAppData = nativeAppData.refresh
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
    wxmlTree: nativeWxml.data,
    appData,
    storageItems,
    refreshWxml: nativeWxml.refresh,
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
