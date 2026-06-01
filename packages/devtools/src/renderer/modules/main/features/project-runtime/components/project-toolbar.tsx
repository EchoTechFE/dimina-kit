import React, { useEffect, useState } from 'react'
import { Button } from '@/shared/components/ui/button'
import { StatusDot } from '@/shared/components/status-dot'
import { cn } from '@/shared/lib/utils'
import { HEADER_H } from '@/shared/constants'
import {
  getHeaderHeight,
  getToolbarActions,
  invokeToolbarAction,
  onToolbarActionsChanged,
} from '@/shared/api'
import type { ToolbarAction } from '@/shared/api'
import type { LayoutStoreApi } from '../controllers/use-layout-store'
import {
  LayoutAlignmentToggle,
  LayoutDevtoolsPositionToggles,
  LayoutVisibilityToggles,
} from './layout-controls'

interface ProjectToolbarProps {
  compileDropdownRef: React.RefObject<HTMLDivElement | null>
  showCompilePanel: boolean
  onToggleCompilePanel: () => void
  onRelaunch: () => void | Promise<void>
  compileStatus: { status: string; message: string }
  layout: LayoutStoreApi
}

/**
 * Visual divider between toolbar action clusters. Mirrors the WeChat
 * DevTools header, where the compile-mode dropdown, primary actions, and
 * pane-visibility toggles sit in separate groups separated by thin rules.
 */
function ToolbarDivider() {
  return <div className="w-px h-4 bg-border mx-1" aria-hidden="true" />
}

function getActionPlacement(action: ToolbarAction): NonNullable<ToolbarAction['placement']> {
  return action.placement ?? 'primary'
}

function getAvatarFallback(action: ToolbarAction): string {
  if (action.displayInitial?.trim()) {
    return Array.from(action.displayInitial.trim())[0] ?? '?'
  }

  const { label } = action
  const trimmed = label.trim()
  if (!trimmed) return '?'
  return Array.from(trimmed)[0] ?? '?'
}

function ToolbarActionButton({
  action,
  disabled,
  onInvoke,
}: {
  action: ToolbarAction
  disabled: boolean
  onInvoke: (id: string) => void
}) {
  const [avatarFailed, setAvatarFailed] = useState(false)
  const isAvatarAction = action.kind === 'avatar' || Boolean(action.avatarUrl)

  useEffect(() => {
    setAvatarFailed(false)
  }, [action.avatarUrl])

  if (isAvatarAction) {
    return (
      <button
        type="button"
        aria-label={action.label}
        title={action.label}
        onClick={() => onInvoke(action.id)}
        disabled={disabled}
        className={cn(
          'inline-flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-surface-thumb text-[13px] font-medium text-text transition-colors',
          'hover:border-border-subtle hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-35',
        )}
      >
        {action.avatarUrl && !avatarFailed ? (
          <img
            src={action.avatarUrl}
            alt=""
            className="h-full w-full object-cover"
            onError={() => setAvatarFailed(true)}
          />
        ) : (
          <span>{getAvatarFallback(action)}</span>
        )}
      </button>
    )
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => onInvoke(action.id)}
      disabled={disabled}
      title={action.label}
    >
      {action.icon && (
        <span className="text-[13px] leading-none" aria-hidden="true">
          {action.icon}
        </span>
      )}
      <span>{action.label}</span>
    </Button>
  )
}

function ToolbarActionGroup({
  actions,
  disabled,
  onInvoke,
}: {
  actions: ToolbarAction[]
  disabled: boolean
  onInvoke: (id: string) => void
}) {
  if (actions.length === 0) return null

  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1" role="group">
      {actions.map((action) => (
        <ToolbarActionButton
          key={action.id}
          action={action}
          disabled={disabled}
          onInvoke={onInvoke}
        />
      ))}
    </div>
  )
}

export function ProjectToolbar({
  compileDropdownRef,
  showCompilePanel,
  onToggleCompilePanel,
  onRelaunch,
  compileStatus,
  layout,
}: ProjectToolbarProps) {
  const [actions, setActions] = useState<ToolbarAction[]>([])
  // Host-configured header height; HEADER_H (40) is the fallback until the
  // IPC value resolves. Fetched once, mirrors the getBranding() pattern.
  const [headerHeight, setHeaderHeight] = useState(HEADER_H)

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
    getHeaderHeight()
      .then((h) => {
        if (typeof h === 'number') setHeaderHeight(h)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetchActions()
    return onToolbarActionsChanged(() => fetchActions())
  }, [])

  const disabled = compileStatus.status === 'compiling'
  const leadingActions = actions.filter((action) => getActionPlacement(action) === 'leading')
  const primaryActions = actions.filter((action) => getActionPlacement(action) === 'primary')
  const trailingActions = actions.filter((action) => getActionPlacement(action) === 'trailing')
  const invokeAction = (id: string) => {
    void invokeToolbarAction(id)
  }

  return (
    <div className="flex flex-col shrink-0">
      <div
        className="flex items-center gap-1.5 px-2.5 bg-surface-2 border-b border-border shrink-0 min-w-0"
        style={{ height: headerHeight }}
      >
        <ToolbarActionGroup actions={leadingActions} disabled={disabled} onInvoke={invokeAction} />
        {leadingActions.length > 0 && <ToolbarDivider />}

        <LayoutVisibilityToggles layout={layout} />
        <ToolbarDivider />

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

        {/* Cluster 2: Primary compile actions (relaunch + host-extension
            toolbar actions render as adjacent buttons in the action row
            above). Keep just the icon-button cluster compact. */}
        <Button
          variant="icon"
          size="icon"
          onClick={() => {
            void onRelaunch()
          }}
          disabled={disabled}
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

        <ToolbarActionGroup actions={primaryActions} disabled={disabled} onInvoke={invokeAction} />

        <div className="flex-1 min-w-2" />

        {/* Cluster 3: Layout controls, all inline toggles (no dropdown).
            Dropdowns were dropped because the editor WebContentsView
            renders above renderer-layer popovers in the OS stacking
            order, so a layout popover would be hidden behind it.
            - LayoutVisibilityToggles: 3 toggles for sim / editor / debug
              (shape change + surface-active chip carries the signal).
            - LayoutAlignmentToggle: single button that swaps simulator
              alignment between left and right.
            - LayoutDevtoolsPositionToggles: 3-button group for the
              devtools-position preset (inEditor / belowSimulator /
              rightOfSimulator). The at-least-one-visible guard lives
              in the store. */}
        <LayoutAlignmentToggle layout={layout} />
        <ToolbarDivider />
        <LayoutDevtoolsPositionToggles layout={layout} />
        {trailingActions.length > 0 && <ToolbarDivider />}
        <ToolbarActionGroup actions={trailingActions} disabled={disabled} onInvoke={invokeAction} />
      </div>
    </div>
  )
}
