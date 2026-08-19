import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { DEVICES, SIM_PANEL_PADDING } from '@/shared/constants'
import type { AppInfo, ProjectStatus, SessionRuntimeStatusPayload } from '@/shared/api'
import type { CompileConfig } from '@/shared/types'
import type { AppDataPanelSource, StoragePanelSource, WxmlPanelSource } from '@dimina-kit/inspect'
import { DEFAULT_RIGHT_PANE_STATE } from '../types'
import type { RightPaneState, RightPaneTabId } from '../types'

import { useDevice, type DeviceHookResult } from './use-device'
import { useSession } from './use-session'
import type { CompileEvent, CompileLogEntry } from './use-session'
import { useSimulator } from './use-simulator'
import { usePanelData } from './use-panel-data'
import { useRightPane } from './use-right-pane'
import { usePopover } from './use-popover'

// ── Public shapes ───────────────────────────────────────────────────────────

export type DeviceType = typeof DEVICES[number]

export type CompileStatus = ProjectStatus

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

/**
 * What the controller republishes from the device hook: everything the hook returns except its internal refs, which exist for the hook's own callers.
 * Derived rather than re-declared so a field added to the hook cannot silently go missing here.
 */
type DeviceSlice = Omit<DeviceHookResult, 'simPanelWidthRef' | 'deviceRef'>

interface SimulatorSlice {
  simulatorRef: RefObject<HTMLElement | null>
  simulatorUrl: string
  currentPage: string
}

interface PanelDataSlice {
  wxmlSource: WxmlPanelSource
  wxmlEnabled: boolean
  storageSource: StoragePanelSource
  storageEnabled: boolean
  appDataSource: AppDataPanelSource
  appDataEnabled: boolean
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

  const sessionHook = useSession({
    projectPath,
  })

  const deviceHook = useDevice({ initialDevice })

  // Sync simulator panel width when the device or its displayed orientation changes — separate from the openProject effect so these don't re-open the project.
  // Sized at orientedDevice.width, not the device's raw portrait width, so a landscape session keeps a landscape-wide panel.
  useEffect(() => {
    if (sessionHook.compileStatus.status === 'ready') {
      deviceHook.setSimPanelWidth(deviceHook.orientedDevice.width + SIM_PANEL_PADDING * 2)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceHook.orientedDevice.width, sessionHook.compileStatus.status, deviceHook.setSimPanelWidth])

  const simulatorHook = useSimulator({
    compileStatus: sessionHook.compileStatus,
    sendDeviceInfo: deviceHook.sendDeviceInfo,
    simPanelWidthRef: deviceHook.simPanelWidthRef,
    deviceRef: deviceHook.deviceRef,
    appInfo: sessionHook.appInfo,
    compileConfig: sessionHook.compileConfig,
    port: sessionHook.port,
    projectPath,
    // Watcher-rebuild signal (resurrects the hot-reload guard a later refactor
    // deleted): each bump makes use-simulator respawn the DeviceShell once.
    hotReloadToken: sessionHook.hotReloadToken,
    // Explicit-relaunch signal: forces a hard re-attach at startPage even when
    // the URL is unchanged (重新编译 / retry resetting the drifted page).
    relaunchNonce: sessionHook.relaunchNonce,
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
      deviceOrientation: deviceHook.deviceOrientation,
      handleRotateDevice: deviceHook.handleRotateDevice,
      canRotate: deviceHook.canRotate,
      orientedDevice: deviceHook.orientedDevice,
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
      wxmlSource: panelDataHook.wxmlSource,
      wxmlEnabled: panelDataHook.wxmlEnabled,
      storageSource: panelDataHook.storageSource,
      storageEnabled: panelDataHook.storageEnabled,
      appDataSource: panelDataHook.appDataSource,
      appDataEnabled: panelDataHook.appDataEnabled,
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
