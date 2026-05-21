import {
  useCallback,
  useEffect,
  useState,
} from 'react'
import type { RefObject } from 'react'
import { useActiveBridgeId } from './use-active-bridge-id'
import { invoke as ipcInvoke, on as ipcOn } from '@/shared/api/ipc-transport'
import {
  SimulatorElementChannel,
  SimulatorStorageChannel,
  type ElementInspection,
  type StorageEvent,
  type StorageItem as StorageItemDto,
  type StorageWriteResult,
} from '../../../../../../shared/ipc-channels'
import type { AppDataSnapshot } from '../../../../../../preload/instrumentation/app-data'
import { ATTACH_RETRY_INTERVAL_MS, MAX_ATTACH_RETRIES } from '../../../../../../preload/shared/constants'
import type { WxmlNode } from '../../right-panel/types.js'
import { asWebview } from './webview-helpers'
import { useMiniappSnapshot } from './use-miniapp-snapshot'
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

const EMPTY_APP_DATA_SNAPSHOT: AppDataSnapshot = {
  bridges: [],
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
  const [storageItems, setStorageItems] = useState<StorageItem[]>([])

  // WXML is projected from the unified miniappSnapshot framework: preload owns
  // the tree, the renderer is a pure projection. reload re-sync is structural.
  const wxml = useMiniappSnapshot<WxmlNode | null>({
    id: 'wxml',
    initial: null,
    simulatorRef,
    enabled: compileStatus.status === 'ready',
  })

  // AppData is likewise a pure projection of the unified snapshot. The
  // `bridges` / `entries` come straight from preload; `activeBridgeId` (which
  // page tab is selected) is renderer-only UI state derived from each new
  // snapshot below.
  const appDataSnapshot = useMiniappSnapshot<AppDataSnapshot>({
    id: 'appdata',
    initial: EMPTY_APP_DATA_SNAPSHOT,
    simulatorRef,
    enabled: compileStatus.status === 'ready',
  })

  const { activeBridgeId, setActiveBridge } = useActiveBridgeId(appDataSnapshot.data.bridges)

  const appData: AppDataState = {
    bridges: appDataSnapshot.data.bridges,
    activeBridgeId,
    entries: appDataSnapshot.data.entries,
  }

  const setActiveAppDataBridge = setActiveBridge

  useEffect(() => {
    if (compileStatus.status !== 'ready') return

    const onCrashed = () => setConnected(false)
    const onLoading = () => setConnected(true)

    // The <webview> element mounts conditionally on `preloadPath && simulatorUrl`,
    // both resolved asynchronously by useSession. compileStatus can flip to
    // 'ready' BEFORE preloadPath resolves, in which case `simulatorRef.current`
    // is still null when this effect first runs and the listeners are never
    // installed (the effect doesn't re-run because the ref identity is stable).
    // Use a bounded retry loop (same constants as preload's tryAttach) to bind
    // once the webview is mounted. Panel data flows through useMiniappSnapshot;
    // this effect only drives `connected` from crash / load lifecycle events.
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
        attached.removeEventListener('crashed', onCrashed)
        attached.removeEventListener('did-start-loading', onLoading)
      }
    }
  }, [compileStatus.status, simulatorRef])

  const refreshAppData = appDataSnapshot.refresh
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
    wxmlTree: wxml.data,
    appData,
    storageItems,
    refreshWxml: wxml.refresh,
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
