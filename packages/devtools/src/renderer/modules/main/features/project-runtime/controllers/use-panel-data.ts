import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { useActiveBridgeId } from './use-active-bridge-id'
import { invoke as ipcInvoke, on as ipcOn } from '@/shared/api/ipc-transport'
import {
  SimulatorAppDataChannel,
  SimulatorStorageChannel,
  type StorageEvent,
  type StorageItem as StorageItemDto,
  type StorageWriteResult,
} from '../../../../../../shared/ipc-channels'
import type { AppDataSnapshot } from '../../../../../../preload/instrumentation/app-data'
import type { WxmlPanelSource } from '@dimina-kit/wxml-inspect'
import { createIpcWxmlPanelSource } from '../../right-panel/wxml-source'
import { useNativeChannelSnapshot } from './use-native-channel-snapshot'
import type { CompileStatus, StorageItem } from './use-project-runtime-controller'

export interface UsePanelDataProps {
  compileStatus: CompileStatus
  /** Bare pagePath of the simulator's active page; AppData follows it. */
  activePagePath?: string
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
  /** WXML data travels through the shared source contract (ConnectedWxmlPanel
   * owns seed/subscribe/visibility); this hook only provides the IPC transport
   * implementation plus the readiness gate. */
  wxmlSource: WxmlPanelSource
  wxmlEnabled: boolean
  appData: AppDataState
  storageItems: StorageItem[]
  refreshAppData: () => void
  setActiveAppDataBridge: (id: string) => void
  refreshStorage: () => void
  setStorageItem: (key: string, value: string) => Promise<StorageWriteResult>
  removeStorageItem: (key: string) => Promise<StorageWriteResult>
  clearStorage: () => Promise<StorageWriteResult>
  clearAllStorage: () => Promise<StorageWriteResult>
  getStoragePrefix: () => Promise<string>
}

export function usePanelData(props: UsePanelDataProps): PanelDataHookResult {
  const { compileStatus, activePagePath = '' } = props

  const [storageItems, setStorageItems] = useState<StorageItem[]>([])

  const ready = compileStatus.status === 'ready'

  // The page DOM lives in render-host <webview> guests and the service logic in
  // the hidden service-host window — neither reachable from the simulator
  // preload — so WXML + AppData are sourced from the main process
  // (simulator-wxml / simulator-appdata services) over dedicated channels:
  // seed via GetSnapshot + live updates via Event. For WXML that whole wiring
  // lives in the shared ConnectedWxmlPanel; this hook only hands it the IPC
  // transport (wxmlSource) and the readiness gate (wxmlEnabled).
  const wxmlSource = useMemo(() => createIpcWxmlPanelSource(), [])

  const nativeAppData = useNativeChannelSnapshot<AppDataSnapshot>({
    getChannel: SimulatorAppDataChannel.GetSnapshot,
    eventChannel: SimulatorAppDataChannel.Event,
    initial: EMPTY_APP_DATA_SNAPSHOT,
    enabled: ready,
  })
  const appDataData = nativeAppData.data

  const { activeBridgeId, setActiveBridge } = useActiveBridgeId(appDataData.bridges, activePagePath)

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
  // Seed Storage on the ready edge (mirrors WXML/AppData's enabled-seed): the
  // Storage panel has no manual refresh button, so an already-active tab that
  // was empty pre-compile must auto-fetch the snapshot once the session is ready
  // — otherwise it would stay empty until the next live storage event.
  useEffect(() => {
    if (ready) void refreshStorage()
  }, [ready, refreshStorage])
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
    wxmlSource,
    wxmlEnabled: ready,
    appData,
    storageItems,
    refreshAppData,
    setActiveAppDataBridge,
    refreshStorage,
    setStorageItem,
    removeStorageItem,
    clearStorage,
    clearAllStorage,
    getStoragePrefix,
  }
}
