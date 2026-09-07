import React from 'react'
import { ChevronDown, RotateCcw, Settings } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { StatusDot } from '@/shared/components/status-dot'
import { useOverlayTooltip } from '@/shared/lib/use-overlay-tooltip'
import { HEADER_H } from '@/shared/constants'
import { prepareTooltip, setSettingsVisible } from '@/shared/api'
import type { LayoutModel, PanelRegistry } from '@dimina-kit/electron-deck/layout'
import {
  LayoutVisibilityToggles,
  LayoutAlignmentToggle,
  LayoutDevtoolsPositionToggles,
} from './layout-controls'
import type { LayoutStoreApi } from '../controllers/use-layout-store'

interface ProjectToolbarProps {
  compileDropdownRef: React.RefObject<HTMLDivElement | null>
  showCompilePanel: boolean
  onToggleCompilePanel: () => void
  /** Name of the selected compile mode, or 普通编译 when none is selected. */
  compileModeLabel: string
  /**
   * Gates the compile-mode button. Before main has opened this window's
   * project into a `CompileModeStore` (and this window has adopted a
   * snapshot/push from it), clicking through would surface a main-process
   * `no compile-mode store open` error instead of a usable menu. Required so
   * every caller states when the button becomes usable.
   */
  compileModesReady: boolean
  onRelaunch: () => void | Promise<void>
  compileStatus: { status: string; message: string }
  /** Dock model + registry powering the panel visibility + layout toggles. */
  dockModel: LayoutModel
  dockRegistry: PanelRegistry
  /** Layout store — drives the alignment / devtools-position preset toggles. */
  layout: LayoutStoreApi
  /** Current device width — seeds a reopened simulator's fixed-px column. */
  simPanelWidth: number
}

/**
 * Visual divider between toolbar action clusters. Mirrors the WeChat
 * DevTools header, where the compile-mode dropdown, primary actions, and
 * pane-visibility toggles sit in separate groups separated by thin rules.
 */
function ToolbarDivider() {
  return <div className="w-px h-4 bg-border mx-1" aria-hidden="true" />
}

/**
 * All button tooltips in this toolbar (here and in `layout-controls.tsx`) use
 * `useOverlayTooltip` (a dedicated tooltip overlay WebContentsView), not the
 * `ui/tooltip` Radix component and not the native `title` attribute — this
 * row sits directly above the Simulator/Editor native WebContentsViews, and
 * BOTH of those render inside the main window's own paint surface, which
 * every WCV mounted on top of it occludes (confirmed live: each was tried
 * and each silently broke every tooltip in this row). Do not re-migrate this
 * row to either.
 */
export function ProjectToolbar({
  compileDropdownRef,
  showCompilePanel,
  onToggleCompilePanel,
  compileModeLabel,
  compileModesReady,
  onRelaunch,
  compileStatus,
  dockModel,
  dockRegistry,
  layout,
  simPanelWidth,
}: ProjectToolbarProps) {
  React.useEffect(() => {
    prepareTooltip()
  }, [])

  const relaunchTooltip = useOverlayTooltip('重新编译')
  const settingsTooltip = useOverlayTooltip('设置')
  return (
    <div className="flex flex-col shrink-0">
      <div
        className="flex items-center gap-1.5 px-2.5 bg-surface-2 border-b border-border shrink-0"
        style={{ height: HEADER_H }}
      >
        {/* Cluster 1: Compile-mode dropdown.
            The dropdown surface itself is a main-process popover
            (showPopover from @/shared/api). Clicking the button toggles it;
            the popover lists 普通编译 plus the project's named modes and
            owns their editing.

            No tooltip: the button already shows the selected mode's name,
            and a tooltip would only repeat it. Disabled until
            compileModesReady: before main has opened this project's
            CompileModeStore, the popover's Show would hit
            `no compile-mode store open` instead of a usable menu. */}
        <div ref={compileDropdownRef as React.Ref<HTMLDivElement>}>
          <Button
            variant="toolbar"
            onClick={onToggleCompilePanel}
            disabled={!compileModesReady}
            data-active={showCompilePanel ? 'true' : 'false'}
            // The button's accessible name is the selected mode's own name, so
            // it changes as the user switches modes; this gives it a stable
            // handle that doesn't depend on which mode is selected.
            data-testid="compile-mode-button"
            className="h-7 gap-0.5 pl-2 pr-1.5 text-[13px] text-text-secondary max-w-40"
          >
            <span className="truncate">{compileModeLabel}</span>
            <ChevronDown className="size-3.5 shrink-0" />
          </Button>
        </div>

        <ToolbarDivider />

        {/* Cluster 2: Primary compile actions. Keep just the icon-button
            cluster compact. */}
        <Button
          variant="toolbar"
          size="icon"
          className="size-7 rounded-[var(--qd-radius-md)]"
          onClick={() => {
            void onRelaunch()
          }}
          disabled={compileStatus.status === 'compiling'}
          aria-label="重新编译"
          {...relaunchTooltip}
        >
          <RotateCcw className="size-3.5" />
        </Button>

        <div className="flex items-center gap-1.5 px-1.5 shrink-0">
          <StatusDot status={compileStatus.status} />
          <span data-testid="compile-status-message" className="text-[12px] text-text-secondary max-w-28 truncate">
            {compileStatus.message}
          </span>
        </div>

        <div className="flex-1 min-w-2" />

        {/* Panel visibility toggles (模拟器 / 编辑器 / 调试器). The dock
            (<DockView>) owns arrangement (drag a tab to re-dock; × to hide);
            these restore the one-click show/hide affordance — hiding closes the
            panel out of the tree, showing re-inserts it at its default position. */}
        <LayoutVisibilityToggles model={dockModel} registry={dockRegistry} simPanelWidth={simPanelWidth} />

        <ToolbarDivider />

        {/* Simulator left/right alignment. */}
        <LayoutAlignmentToggle model={dockModel} layout={layout} simPanelWidth={simPanelWidth} />

        <ToolbarDivider />

        {/* Devtools/debug region position presets (in-editor / below / right). */}
        <LayoutDevtoolsPositionToggles model={dockModel} layout={layout} simPanelWidth={simPanelWidth} />

        <ToolbarDivider />

        {/* Settings entry point. Stateless open-only: the embedded
            project-settings overlay owns its own close path, so the button
            always sends `true` (a toggle could not observe the overlay's
            real state and would desync). */}
        <Button
          variant="toolbar"
          size="icon"
          className="size-7 rounded-[var(--qd-radius-md)]"
          onClick={() => {
            void setSettingsVisible(true)
          }}
          aria-label="设置"
          {...settingsTooltip}
        >
          <Settings className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}
