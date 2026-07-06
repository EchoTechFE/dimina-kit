import type React from 'react'
import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { DEVICES, SIM_PANEL_PADDING } from '@/shared/constants'
import type { AppInfo, ProjectStatus, SessionRuntimeStatusPayload } from '@/shared/api'
import type { CompileConfig } from '@/shared/types'
import type { ElementInspection, StorageWriteResult } from '../../../../../../shared/ipc-channels'
import type { WxmlNode } from '../../right-panel/types.js'
import { DEFAULT_RIGHT_PANE_STATE } from '../types'
import type { RightPaneState, RightPaneTabId } from '../types'

import { useDevice } from './use-device'
import { useSession } from './use-session'
import type { CompileEvent, CompileLogEntry } from './use-session'
import { useSimulator } from './use-simulator'
import { usePanelData, type AppDataState } from './use-panel-data'
import { useRightPane } from './use-right-pane'
import { usePopover } from './use-popover'

// ── Public shapes ───────────────────────────────────────────────────────────

export type DeviceType = typeof DEVICES[number]

export type CompileStatus = ProjectStatus

export interface StorageItem {
  key: string
  value: unknown
}

export interface ProjectRuntimeControllerProps {
  projectPath: string
  initialDevice?: DeviceType
  initialRightPane?: RightPaneState
}

interface SessionSlice {
  compileStatus: CompileStatus
  appInfo: AppInfo | null
  port: number
  pages: string[]
  compileConfig: CompileConfig
  /** 编译 tab event log (useSession passthrough — feeds BottomDebugPanel). */
  compileEvents: CompileEvent[]
  /** 编译 tab per-line dmcc log (useSession passthrough). */
  compileLogs: CompileLogEntry[]
  /** Clears both compileEvents and compileLogs. */
  clearCompileEvents: () => void
  relaunch: (nextConfig?: CompileConfig) => Promise<void>
  /** Latest runtime-lifecycle push for the active session; null when healthy/unreported, or right after a hot-reload starts a fresh launch round. */
  runtimeStatus: SessionRuntimeStatusPayload | null
  /** True once the project's file watcher has died for this session. */
  watcherDead: boolean
}

interface DeviceSlice {
  device: DeviceType
  zoom: number
  simPanelWidth: number
  setSimPanelWidth: (width: number) => void
  handleDeviceChange: (e: React.ChangeEvent<HTMLSelectElement>) => void
  handleZoomChange: (e: React.ChangeEvent<HTMLSelectElement>) => void
  handleSplitterDrag: (e: React.MouseEvent) => void
  sendDeviceInfo: (device: DeviceType) => void
}

interface SimulatorSlice {
  simulatorRef: RefObject<HTMLElement | null>
  simulatorUrl: string
  currentPage: string
}

interface PanelDataSlice {
  wxmlTree: WxmlNode | null
  appData: AppDataState
  storageItems: StorageItem[]
  refreshWxml: () => void
  refreshAppData: () => void
  setActiveAppDataBridge: (id: string) => void
  refreshStorage: () => void
  setWxmlActive: (on: boolean) => void
  setStorageItem: (key: string, value: string) => Promise<StorageWriteResult>
  removeStorageItem: (key: string) => Promise<StorageWriteResult>
  clearStorage: () => Promise<StorageWriteResult>
  clearAllStorage: () => Promise<StorageWriteResult>
  getStoragePrefix: () => Promise<string>
  inspectWxmlElement: (sid: string) => Promise<ElementInspection | null>
  clearWxmlElementInspection: () => Promise<void>
}

interface RightPaneSlice {
  rightPane: RightPaneState
  selectRightPane: (panelId: RightPaneTabId) => void
  toggleRightPaneVisible: () => void
}

interface PopoverSlice {
  compileDropdownRef: RefObject<HTMLDivElement | null>
  showCompilePanel: boolean
  toggleCompilePanel: () => void
}

export interface ProjectRuntimeController {
  session: SessionSlice
  device: DeviceSlice
  simulator: SimulatorSlice
  panelData: PanelDataSlice
  rightPane: RightPaneSlice
  popover: PopoverSlice
}

// ── Controller ──────────────────────────────────────────────────────────────

/**
 * Central controller for the ProjectRuntime feature. Composes session,
 * device, simulator, panel-data, right-pane and popover state into a single
 * entry point so `project-runtime.tsx` stays declarative.
 *
 * Side-effect ordering preserved from the pre-controller hooks:
 *  1. openProject → getProjectPages / getCompileConfig → compileStatus ready
 *  2. compileStatus ready → webview attach + sendDeviceInfo + ipc-message
 *  3. popover:closed → clear showCompilePanel; popover:relaunch → relaunch()
 */
export function useProjectRuntimeController(
  props: ProjectRuntimeControllerProps,
): ProjectRuntimeController {
  const {
    projectPath,
    initialDevice = DEVICES[1]!,
    initialRightPane = DEFAULT_RIGHT_PANE_STATE,
  } = props

  const simulatorRef = useRef<HTMLElement | null>(null)
  const compileDropdownRef = useRef<HTMLDivElement | null>(null)

  // ── Compose sub-hooks ────────────────────────────────────────────────────

  const deviceHook = useDevice({ initialDevice })

  const sessionHook = useSession({
    projectPath,
  })

  // Sync simulator panel width when device changes — separate from the
  // openProject effect so device switches don't re-open the project.
  useEffect(() => {
    if (sessionHook.compileStatus.status === 'ready') {
      deviceHook.setSimPanelWidth(deviceHook.device.width + SIM_PANEL_PADDING * 2)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceHook.device.width, sessionHook.compileStatus.status, deviceHook.setSimPanelWidth])

  const simulatorHook = useSimulator({
    compileStatus: sessionHook.compileStatus,
    sendDeviceInfo: deviceHook.sendDeviceInfo,
    simPanelWidthRef: deviceHook.simPanelWidthRef,
    deviceRef: deviceHook.deviceRef,
    appInfo: sessionHook.appInfo,
    compileConfig: sessionHook.compileConfig,
    port: sessionHook.port,
    projectPath,
    // Watcher-rebuild signal (resurrected PR#12 hot-reload guard, deleted in
    // PR#39): each bump makes use-simulator respawn the DeviceShell once.
    hotReloadToken: sessionHook.hotReloadToken,
  })

  const panelDataHook = usePanelData({
    compileStatus: sessionHook.compileStatus,
    activePagePath: simulatorHook.currentPage,
  })

  const rightPaneHook = useRightPane({
    initialRightPane,
  })

  const popoverHook = usePopover({
    relaunch: sessionHook.relaunch,
    compileConfig: sessionHook.compileConfig,
    pages: sessionHook.pages,
    compileDropdownRef,
    launchConfigs: sessionHook.launchConfigs,
    activeLaunchConfigId: sessionHook.activeLaunchConfigId,
    switchLaunchConfig: sessionHook.switchLaunchConfig,
    updateLaunchConfigs: sessionHook.updateLaunchConfigs,
  })

  // ── Assemble slices ───────────────────────────────────────────────────────

  return {
    session: {
      compileStatus: sessionHook.compileStatus,
      appInfo: sessionHook.appInfo,
      port: sessionHook.port,
      pages: sessionHook.pages,
      compileConfig: sessionHook.compileConfig,
      compileEvents: sessionHook.compileEvents,
      compileLogs: sessionHook.compileLogs,
      clearCompileEvents: sessionHook.clearCompileEvents,
      relaunch: sessionHook.relaunch,
      runtimeStatus: sessionHook.runtimeStatus,
      watcherDead: sessionHook.watcherDead,
    },
    device: {
      device: deviceHook.device,
      zoom: deviceHook.zoom,
      simPanelWidth: deviceHook.simPanelWidth,
      setSimPanelWidth: deviceHook.setSimPanelWidth,
      handleDeviceChange: deviceHook.handleDeviceChange,
      handleZoomChange: deviceHook.handleZoomChange,
      handleSplitterDrag: deviceHook.handleSplitterDrag,
      sendDeviceInfo: deviceHook.sendDeviceInfo,
    },
    simulator: {
      simulatorRef,
      simulatorUrl: simulatorHook.simulatorUrl,
      currentPage: simulatorHook.currentPage,
    },
    panelData: {
      wxmlTree: panelDataHook.wxmlTree,
      appData: panelDataHook.appData,
      storageItems: panelDataHook.storageItems,
      refreshWxml: panelDataHook.refreshWxml,
      refreshAppData: panelDataHook.refreshAppData,
      setActiveAppDataBridge: panelDataHook.setActiveAppDataBridge,
      refreshStorage: panelDataHook.refreshStorage,
      setWxmlActive: panelDataHook.setWxmlActive,
      setStorageItem: panelDataHook.setStorageItem,
      removeStorageItem: panelDataHook.removeStorageItem,
      clearStorage: panelDataHook.clearStorage,
      clearAllStorage: panelDataHook.clearAllStorage,
      getStoragePrefix: panelDataHook.getStoragePrefix,
      inspectWxmlElement: panelDataHook.inspectWxmlElement,
      clearWxmlElementInspection: panelDataHook.clearWxmlElementInspection,
    },
    rightPane: {
      rightPane: rightPaneHook.rightPane,
      selectRightPane: rightPaneHook.selectRightPane,
      toggleRightPaneVisible: rightPaneHook.toggleRightPaneVisible,
    },
    popover: {
      compileDropdownRef,
      showCompilePanel: popoverHook.showCompilePanel,
      toggleCompilePanel: popoverHook.toggleCompilePanel,
    },
  }
}
