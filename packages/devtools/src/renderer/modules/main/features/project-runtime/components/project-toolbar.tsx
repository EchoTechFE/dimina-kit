import React from 'react'
import { Button } from '@/shared/components/ui/button'
import { StatusDot } from '@/shared/components/status-dot'
import { cn } from '@/shared/lib/utils'
import { HEADER_H } from '@/shared/constants'
import { setSettingsVisible } from '@/shared/api'

interface ProjectToolbarProps {
  compileDropdownRef: React.RefObject<HTMLDivElement | null>
  showCompilePanel: boolean
  onToggleCompilePanel: () => void
  onRelaunch: () => void | Promise<void>
  compileStatus: { status: string; message: string }
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

        {/* Panel layout is owned entirely by the dock (<DockView>): drag a
            panel's tab to re-dock it. The legacy visibility/alignment/
            devtools-position preset toggles were removed with the FrameTree
            layout they drove — free-form docking replaces them. */}

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
