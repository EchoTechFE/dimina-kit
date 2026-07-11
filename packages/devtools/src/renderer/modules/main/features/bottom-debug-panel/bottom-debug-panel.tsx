import { type ReactNode } from 'react'
import type { StoragePanelSource, WxmlPanelSource } from '@dimina-kit/inspect'
import { ConnectedStoragePanel, ConnectedWxmlPanel } from '@dimina-kit/inspect/panel'
import { AppDataPanel } from '../right-panel/appdata-panel.js'
import { CompilePanel } from '../right-panel/compile-panel.js'
import type { AppDataState } from '../project-runtime/controllers/use-panel-data.js'
import type {
  CompileEvent,
  CompileLogEntry,
} from '../project-runtime/controllers/use-session.js'
import type { RightPaneState, RightPaneTabId } from '../project-runtime/types.js'

export interface BottomDebugPanelProps {
  rightPane: RightPaneState
  onSelectTab: (id: RightPaneTabId) => void

  // Data + handlers for built-in panels.
  /** WXML and Storage data wiring lives in the shared ConnectedWxmlPanel /
   * ConnectedStoragePanel: the host only supplies the IPC transports
   * (sources), the readiness gates (enabled) and — via DebugTabContent's
   * `tabActive` — the tab-visibility gate. */
  wxmlSource: WxmlPanelSource
  wxmlEnabled?: boolean
  storageSource: StoragePanelSource
  storageEnabled?: boolean

  appData: AppDataState
  onRefreshAppData: () => void
  onSelectAppDataBridge: (id: string) => void

  // 编译 tab: event log + per-line dmcc log, pure passthrough to
  // CompilePanel. Optional so embedders without a compile feed keep working.
  compileEvents?: CompileEvent[]
  compileLogs?: CompileLogEntry[]
  onClearCompileEvents?: () => void

  /**
   * True while the compiled mini-program's runtime session is actually
   * `running`. Lets WxmlPanel/AppDataPanel/StoragePanel distinguish "小程序未
   * 运行" from a true empty-data vacuum in their empty states. Optional
   * (defaults to `true`) so embedders that don't wire runtime status keep
   * their pre-existing empty-state text.
   */
  isRuntimeRunning?: boolean
}

/** The four DOM debug tabs DebugTabContent can render (Console is native). */
export type DebugTabContentId = 'wxml' | 'appdata' | 'storage' | 'compile'

/**
 * Reusable per-tab content for the four React-content debug tabs. Renders
 * WxmlPanel / AppDataPanel / StoragePanel / CompilePanel based on `tabId`,
 * wired to the forwarded handlers. Console is NOT a case here: it is a native
 * main-process overlay owned by the dock's native slot, never a DOM render.
 *
 * This is the single source of per-tab content the dockable `renderDomPanel(id)`
 * mounts for each fine debug panel, so no handler is duplicated or dropped.
 */
export function DebugTabContent(
  props: { tabId: DebugTabContentId, tabActive?: boolean } & BottomDebugPanelProps,
): ReactNode {
  // The panels are live (no manual refresh button): storage syncs via
  // storageChanged, WXML via the render-guest observer, AppData via the setData
  // tap. `onRefreshAppData` stays on BottomDebugPanelProps for the
  // seed-on-activation edge in `DockDebugTab`, but is NOT forwarded to the panel
  // components anymore; WXML's and Storage's activation-edge seed + visibility
  // gate live in the shared connected containers, driven by `tabActive`.
  const {
    tabId,
    wxmlSource,
    wxmlEnabled = true,
    storageSource,
    storageEnabled = true,
    tabActive = true,
    appData,
    onSelectAppDataBridge,
    compileEvents = [],
    compileLogs = [],
    onClearCompileEvents,
    isRuntimeRunning = true,
  } = props

  switch (tabId) {
    case 'wxml':
      return (
        <ConnectedWxmlPanel
          source={wxmlSource}
          enabled={wxmlEnabled}
          active={tabActive}
          isRuntimeRunning={isRuntimeRunning}
        />
      )
    case 'appdata':
      return (
        <AppDataPanel
          state={appData}
          onSelectBridge={onSelectAppDataBridge}
          isRuntimeRunning={isRuntimeRunning}
        />
      )
    case 'storage':
      return (
        <ConnectedStoragePanel
          source={storageSource}
          enabled={storageEnabled}
          active={tabActive}
          isRuntimeRunning={isRuntimeRunning}
        />
      )
    case 'compile':
      return (
        <CompilePanel
          events={compileEvents}
          logs={compileLogs}
          onClear={onClearCompileEvents ?? (() => {})}
        />
      )
  }
}
