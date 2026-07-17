import { useMemo } from 'react'
import type { AppDataPanelSource, StoragePanelSource, WxmlPanelSource } from '@dimina-kit/inspect'
import { createIpcWxmlPanelSource } from '../../right-panel/wxml-source'
import { createIpcStoragePanelSource } from '../../right-panel/storage-source'
import { createIpcAppDataPanelSource } from '../../right-panel/appdata-source'
import type { CompileStatus } from './use-project-runtime-controller'

export interface UsePanelDataProps {
  compileStatus: CompileStatus
  /** Bare pagePath of the simulator's active page; AppData follows it. */
  activePagePath?: string
}

export interface PanelDataHookResult {
  /** WXML, Storage and AppData data travel through the shared source
   * contracts (ConnectedWxmlPanel / ConnectedStoragePanel / ConnectedAppDataPanel
   * own seed/subscribe/visibility/writes); this hook only provides the IPC
   * transport implementations plus the readiness gate. */
  wxmlSource: WxmlPanelSource
  wxmlEnabled: boolean
  storageSource: StoragePanelSource
  storageEnabled: boolean
  appDataSource: AppDataPanelSource
  appDataEnabled: boolean
}

export function usePanelData(props: UsePanelDataProps): PanelDataHookResult {
  const { compileStatus } = props

  const ready = compileStatus.status === 'ready'

  // The page DOM lives in render-host <webview> guests and the service logic in
  // the hidden service-host window — neither reachable from the simulator
  // preload — so WXML + AppData + Storage are sourced from the main process
  // (simulator-wxml / simulator-appdata / simulator-storage services) over
  // dedicated channels: seed via GetSnapshot + live updates via Event. That
  // whole wiring lives in the shared ConnectedWxmlPanel / ConnectedStoragePanel
  // / ConnectedAppDataPanel; this hook only hands them the IPC transports and
  // the readiness gate.
  const wxmlSource = useMemo(() => createIpcWxmlPanelSource(), [])
  const storageSource = useMemo(() => createIpcStoragePanelSource(), [])
  const appDataSource = useMemo(() => createIpcAppDataPanelSource(), [])

  return {
    wxmlSource,
    wxmlEnabled: ready,
    storageSource,
    storageEnabled: ready,
    appDataSource,
    appDataEnabled: ready,
  }
}
