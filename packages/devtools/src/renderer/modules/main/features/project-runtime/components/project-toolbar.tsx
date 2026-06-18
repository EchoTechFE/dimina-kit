import React from 'react'
import { Button } from '@/shared/components/ui/button'
import { StatusDot } from '@/shared/components/status-dot'
import { cn } from '@/shared/lib/utils'
import { HEADER_H } from '@/shared/constants'
import { setSettingsVisible } from '@/shared/api'
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

export function ProjectToolbar({
  compileDropdownRef,
  showCompilePanel,
  onToggleCompilePanel,
  onRelaunch,
  compileStatus,
  dockModel,
  dockRegistry,
  layout,
  simPanelWidth,
}: ProjectToolbarProps) {
  return (
    <div className="flex flex-col shrink-0">
      <div
        className="flex items-center gap-1.5 px-2.5 bg-surface-2 border-b border-border shrink-0"
        style={{ height: HEADER_H }}
      >
        {/* Cluster 1: Compile-mode dropdown.
            The dropdown surface itself is a main-process popover
            (showPopover from @/shared/api). Clicking the button toggles
            its visibility; the popover exposes 普通编译 / 自定义编译 with
            scene-value, launch-page and launch-args inputs. */}
        <div ref={compileDropdownRef as React.Ref<HTMLDivElement>}>
          <Button
            variant="outline"
            size="sm"
            onClick={onToggleCompilePanel}
            className={cn(showCompilePanel && 'border-accent')}
            title="编译模式"
          >
            普通编译 <span className="text-[10px] text-text-secondary">▾</span>
          </Button>
        </div>

        <ToolbarDivider />

        {/* Cluster 2: Primary compile actions. Keep just the icon-button
            cluster compact. */}
        <Button
          variant="icon"
          size="icon"
          onClick={() => {
            void onRelaunch()
          }}
          disabled={compileStatus.status === 'compiling'}
          title="重新编译"
        >
          ↺
        </Button>

        <div className="flex items-center gap-1.5 px-1.5 shrink-0">
          <StatusDot status={compileStatus.status} />
          <span className="text-[11px] text-text-muted max-w-28 truncate">
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
          variant="icon"
          size="icon"
          onClick={() => {
            void setSettingsVisible(true)
          }}
          title="设置"
        >
          ⚙
        </Button>
      </div>
    </div>
  )
}
