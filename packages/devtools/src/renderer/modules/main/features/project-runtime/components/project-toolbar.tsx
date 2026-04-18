import React, { useEffect, useState } from 'react'
import { Button } from '@/shared/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'
import { StatusDot } from '@/shared/components/status-dot'
import { cn } from '@/shared/lib/utils'
import { HEADER_H } from '@/shared/constants'
import {
  getToolbarActions,
  invokeToolbarAction,
  listPanels,
  onToolbarActionsChanged,
} from '@/shared/api'
import type { PanelTab, ToolbarAction } from '@/shared/api'
import type { RightPaneState, RightPaneTabId } from '../types'

interface ProjectToolbarProps {
  compileDropdownRef: React.RefObject<HTMLDivElement | null>
  showCompilePanel: boolean
  onToggleCompilePanel: () => void
  onRelaunch: () => void | Promise<void>
  compileStatus: { status: string; message: string }
  rightPane: RightPaneState
  onToggleRightPaneVisible: () => void
  onSelectRightPane: (panelId: RightPaneTabId) => void
}

export function ProjectToolbar({
  compileDropdownRef,
  showCompilePanel,
  onToggleCompilePanel,
  onRelaunch,
  compileStatus,
  rightPane,
  onToggleRightPaneVisible,
  onSelectRightPane,
}: ProjectToolbarProps) {
  const [actions, setActions] = useState<ToolbarAction[]>([])
  const [panels, setPanels] = useState<PanelTab[]>([])

  const fetchActions = () => {
    void getToolbarActions()
      .then((result) => {
        setActions(Array.isArray(result) ? result : [])
      })
      .catch((err: unknown) => {
        // toolbar:getActions may not be registered — this is expected
        console.debug('[toolbar] getActions not available', err)
      })
  }

  useEffect(() => {
    fetchActions()
    void listPanels()
      .then((result) => {
        if (result?.length) setPanels(result)
      })
      .catch((err: unknown) => {
        console.warn('[toolbar] panel:list failed', err)
      })

    return onToolbarActionsChanged(() => fetchActions())
  }, [])

  return (
    <div className="flex flex-col shrink-0">
      {actions.length > 0 && (
        <div className="flex items-center gap-1.5 px-2.5 py-1 bg-surface-2 border-b border-border">
          {actions.map((action) => (
            <Button
              key={action.id}
              variant="outline"
              size="sm"
              onClick={() => invokeToolbarAction(action.id)}
              disabled={compileStatus.status === 'compiling'}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}

      <div
        className="flex items-center gap-1.5 px-2.5 bg-surface-2 border-b border-border shrink-0"
        style={{ height: HEADER_H }}
      >
        <div ref={compileDropdownRef as React.Ref<HTMLDivElement>}>
          <Button
            variant="outline"
            size="sm"
            onClick={onToggleCompilePanel}
            className={cn(showCompilePanel && 'border-accent')}
          >
            普通编译 <span className="text-[10px] text-text-secondary">▾</span>
          </Button>
        </div>

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

        {panels.length > 0 && (
          <Tabs value={rightPane.selected} onValueChange={(v) => onSelectRightPane(v as RightPaneTabId)}>
            <TabsList className="h-auto gap-px bg-bg border border-border p-0">
              <TabsTrigger
                value="simulator"
                className="px-2 py-0.5 text-[11px] rounded-none data-[state=active]:shadow-none"
              >
                DevTools
              </TabsTrigger>
              {panels.map((panel) => (
                <TabsTrigger
                  key={panel.id}
                  value={panel.id}
                  className="px-2 py-0.5 text-[11px] rounded-none data-[state=active]:shadow-none"
                >
                  {panel.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}

        <Button
          variant="icon"
          size="icon"
          onClick={onToggleRightPaneVisible}
          title={rightPane.simulatorVisible ? '隐藏面板' : '显示面板'}
          className="text-base"
        >
          {rightPane.simulatorVisible ? '⊟' : '⊞'}
        </Button>
      </div>
    </div>
  )
}
