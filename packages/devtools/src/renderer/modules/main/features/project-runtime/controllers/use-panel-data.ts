import { useMemo } from 'react'
import { useActiveBridgeId } from './use-active-bridge-id'
import { SimulatorAppDataChannel } from '../../../../../../shared/ipc-channels'
import type { AppDataSnapshot } from '../../../../../../preload/instrumentation/app-data'
import type { StoragePanelSource, WxmlPanelSource } from '@dimina-kit/inspect'
import { createIpcWxmlPanelSource } from '../../right-panel/wxml-source'
import { createIpcStoragePanelSource } from '../../right-panel/storage-source'
import { useNativeChannelSnapshot } from './use-native-channel-snapshot'
import type { CompileStatus } from './use-project-runtime-controller'

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
  /** WXML and Storage data travel through the shared source contracts
   * (ConnectedWxmlPanel / ConnectedStoragePanel own seed/subscribe/
   * visibility/writes); this hook only provides the IPC transport
   * implementations plus the readiness gate. */
  wxmlSource: WxmlPanelSource
  wxmlEnabled: boolean
  storageSource: StoragePanelSource
  storageEnabled: boolean
  appData: AppDataState
  refreshAppData: () => void
  setActiveAppDataBridge: (id: string) => void
}

export function usePanelData(props: UsePanelDataProps): PanelDataHookResult {
  const { compileStatus, activePagePath = '' } = props

  const ready = compileStatus.status === 'ready'

  // The page DOM lives in render-host <webview> guests and the service logic in
  // the hidden service-host window — neither reachable from the simulator
  // preload — so WXML + AppData + Storage are sourced from the main process
  // (simulator-wxml / simulator-appdata / simulator-storage services) over
  // dedicated channels: seed via GetSnapshot + live updates via Event. For
  // WXML and Storage that whole wiring lives in the shared ConnectedWxmlPanel
  // / ConnectedStoragePanel; this hook only hands them the IPC transports
  // (wxmlSource / storageSource) and the readiness gate.
  const wxmlSource = useMemo(() => createIpcWxmlPanelSource(), [])
  const storageSource = useMemo(() => createIpcStoragePanelSource(), [])

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

  return {
    wxmlSource,
    wxmlEnabled: ready,
    storageSource,
    storageEnabled: ready,
    appData,
    refreshAppData,
    setActiveAppDataBridge,
  }
}
