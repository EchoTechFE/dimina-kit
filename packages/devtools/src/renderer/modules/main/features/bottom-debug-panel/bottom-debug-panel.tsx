import { type ReactNode } from 'react'
import type { WxmlNode } from '@dimina-kit/wxml-inspect'
import type { ElementInspection, StorageWriteResult } from '../../../../../shared/ipc-channels.js'
import { WxmlPanel } from '@dimina-kit/wxml-inspect/panel'
import { AppDataPanel } from '../right-panel/appdata-panel.js'
import { StoragePanel } from '../right-panel/storage-panel.js'
import { CompilePanel } from '../right-panel/compile-panel.js'
import type { AppDataState } from '../project-runtime/controllers/use-panel-data.js'
import type {
  CompileEvent,
  CompileLogEntry,
} from '../project-runtime/controllers/use-session.js'
import type { RightPaneState, RightPaneTabId } from '../project-runtime/types.js'

interface StorageItem { key: string; value: unknown }

export interface BottomDebugPanelProps {
  rightPane: RightPaneState
  onSelectTab: (id: RightPaneTabId) => void

  // Data + handlers for built-in panels.
  wxmlTree: WxmlNode | null
  onRefreshWxml: () => void
  /** Notify main when the WXML panel becomes visible/hidden (gates the live
   * DOM observer + tree pushes so an unseen panel never walks the Vue tree). */
  onWxmlActiveChange?: (on: boolean) => void
  onInspectWxml?: (sid: string) => Promise<ElementInspection | null>
  onClearWxmlInspection?: () => Promise<void>

  appData: AppDataState
  onRefreshAppData: () => void
  onSelectAppDataBridge: (id: string) => void

  storageItems: StorageItem[]
  onRefreshStorage: () => void
  onSetStorage: (key: string, value: string) => Promise<StorageWriteResult>
  onRemoveStorage: (key: string) => Promise<StorageWriteResult>
  onClearStorage: () => Promise<StorageWriteResult>
  onClearAllStorage: () => Promise<StorageWriteResult>
  getStoragePrefix: () => Promise<string>

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
  props: { tabId: DebugTabContentId } & BottomDebugPanelProps,
): ReactNode {
  // The panels are live (no manual refresh button): storage syncs via
  // storageChanged, WXML via the render-guest observer, AppData via the setData
  // tap. `onRefreshWxml/AppData/Storage` stay on BottomDebugPanelProps for the
  // seed-on-activation edge in `DockDebugTab`, but are NOT forwarded to the panel
  // components anymore.
  const {
    tabId,
    wxmlTree,
    onInspectWxml,
    onClearWxmlInspection,
    appData,
    onSelectAppDataBridge,
    storageItems,
    onSetStorage,
    onRemoveStorage,
    onClearStorage,
    onClearAllStorage,
    getStoragePrefix,
    compileEvents = [],
    compileLogs = [],
    onClearCompileEvents,
    isRuntimeRunning = true,
  } = props

  switch (tabId) {
    case 'wxml':
      return (
        <WxmlPanel
          tree={wxmlTree}
          onInspectElement={onInspectWxml}
          onClearInspection={onClearWxmlInspection}
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
        <StoragePanel
          items={storageItems}
          onSet={onSetStorage}
          onRemove={onRemoveStorage}
          onClear={onClearStorage}
          onClearAll={onClearAllStorage}
          getPrefix={getStoragePrefix}
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
