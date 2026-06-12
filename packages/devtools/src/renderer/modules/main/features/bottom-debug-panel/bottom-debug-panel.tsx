import { type ForwardedRef, forwardRef } from 'react'
import { cn } from '@/shared/lib/utils'
import type { WxmlNode } from '../right-panel/types.js'
import type { ElementInspection, StorageWriteResult } from '../../../../../shared/ipc-channels.js'
import { WxmlPanel } from '../right-panel/wxml-panel.js'
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

/**
 * Tab definitions for the bottom debug panel. Console maps to the
 * simulator's Chromium DevTools WebContentsView (positioned by the main
 * process onto the placeholder rect we expose via `simulatorDevtoolsRef`).
 *
 * The order mirrors WeChat DevTools, plus the compile log appended last:
 * WXML / AppData / Storage / Console / 编译.
 */
const TABS: Array<{ id: RightPaneTabId; label: string }> = [
  { id: 'wxml', label: 'WXML' },
  { id: 'appdata', label: 'AppData' },
  { id: 'storage', label: 'Storage' },
  { id: 'simulator', label: 'Console' },
  { id: 'compile', label: '编译' },
]

export interface BottomDebugPanelProps {
  rightPane: RightPaneState
  onSelectTab: (id: RightPaneTabId) => void

  // Data + handlers for built-in panels.
  wxmlTree: WxmlNode | null
  onRefreshWxml: () => void
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
}

/**
 * Horizontal bottom panel hosting the five debug tabs. WXML / AppData /
 * Storage / 编译 render React content; Console reserves an empty div whose
 * client rect the parent measures and pushes to the main process — the
 * simulator's Chromium DevTools WebContentsView is positioned to overlay
 * that div.
 *
 * The component forwards a ref to the Console placeholder so the parent
 * (`project-runtime.tsx`) can attach a `ResizeObserver` without lifting
 * the tab-bar state up.
 */
export const BottomDebugPanel = forwardRef(function BottomDebugPanel(
  props: BottomDebugPanelProps,
  simulatorDevtoolsRef: ForwardedRef<HTMLDivElement>,
) {
  const {
    rightPane,
    onSelectTab,
    wxmlTree,
    onRefreshWxml,
    onInspectWxml,
    onClearWxmlInspection,
    appData,
    onRefreshAppData,
    onSelectAppDataBridge,
    storageItems,
    onRefreshStorage,
    onSetStorage,
    onRemoveStorage,
    onClearStorage,
    onClearAllStorage,
    getStoragePrefix,
    compileEvents = [],
    compileLogs = [],
    onClearCompileEvents,
  } = props

  const selected = rightPane.selected

  const handleSelectTab = (id: RightPaneTabId) => {
    onSelectTab(id)
    if (id === 'wxml') onRefreshWxml()
    else if (id === 'appdata') onRefreshAppData()
    else if (id === 'storage') void onRefreshStorage()
    // 'compile' needs no refresh: its data is push-fed (projectStatus +
    // compileLog subscriptions in useSession).
  }

  return (
    <div className="flex flex-col h-full w-full bg-surface overflow-hidden">
      {/* Tab bar */}
      <div
        role="tablist"
        aria-label="Debug tools"
        data-bottom-debug-tabs
        className="flex items-center gap-1 px-2 h-8 shrink-0 border-b border-border-subtle bg-surface-2"
      >
        {TABS.map((tab) => {
          const active = selected === tab.id
          return (
            <button
              key={tab.id}
              role="tab"
              type="button"
              aria-selected={active}
              data-tab-id={tab.id}
              onClick={() => handleSelectTab(tab.id)}
              className={cn(
                'px-3 h-7 text-[12px] rounded-sm transition-colors',
                active
                  ? 'bg-surface-selected text-text shadow-sm'
                  : 'text-text-muted hover:text-text hover:bg-surface',
              )}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Tab body. Each panel uses display:none rather than unmount so
          React-tree state (tree expand/collapse, scroll position, etc.)
          survives a tab switch — mirrors the keepalive pattern the
          previous right-pane layout used for AppDataPanel. */}
      <div className="flex-1 min-h-0 relative">
        <div
          role="tabpanel"
          data-tab-panel="wxml"
          className="absolute inset-0 flex overflow-hidden"
          style={{ display: selected === 'wxml' ? 'flex' : 'none' }}
        >
          <WxmlPanel
            tree={wxmlTree}
            onRefresh={onRefreshWxml}
            onInspectElement={onInspectWxml}
            onClearInspection={onClearWxmlInspection}
          />
        </div>

        <div
          role="tabpanel"
          data-tab-panel="appdata"
          className="absolute inset-0 flex overflow-hidden"
          style={{ display: selected === 'appdata' ? 'flex' : 'none' }}
        >
          <AppDataPanel
            state={appData}
            onRefresh={onRefreshAppData}
            onSelectBridge={onSelectAppDataBridge}
          />
        </div>

        <div
          role="tabpanel"
          data-tab-panel="storage"
          className="absolute inset-0 flex overflow-hidden"
          style={{ display: selected === 'storage' ? 'flex' : 'none' }}
        >
          <StoragePanel
            items={storageItems}
            onRefresh={onRefreshStorage}
            onSet={onSetStorage}
            onRemove={onRemoveStorage}
            onClear={onClearStorage}
            onClearAll={onClearAllStorage}
            getPrefix={getStoragePrefix}
          />
        </div>

        <div
          role="tabpanel"
          data-tab-panel="compile"
          className="absolute inset-0 flex overflow-hidden"
          style={{ display: selected === 'compile' ? 'flex' : 'none' }}
        >
          <CompilePanel
            events={compileEvents}
            logs={compileLogs}
            onClear={onClearCompileEvents ?? (() => {})}
          />
        </div>

        {/* Console = the simulator's Chromium DevTools WebContentsView.
            The view itself is a main-process overlay; we just reserve the
            rectangle and let the parent push our bounding rect via IPC.
            Always mounted (the main process keeps the WebContents alive
            across tab switches); we hide via display:none, which yields
            a zero-area client rect → the main process detaches the
            overlay from contentView. */}
        <div
          ref={simulatorDevtoolsRef}
          role="tabpanel"
          data-tab-panel="simulator"
          data-area="simulator-devtools"
          className="absolute inset-0"
          style={{ display: selected === 'simulator' ? 'block' : 'none' }}
        />
      </div>
    </div>
  )
})
