import React from 'react'
import { Button } from '@/shared/components/ui/button'
import { StatusDot } from '@/shared/components/status-dot'
import { cn } from '@/shared/lib/utils'
import { HEADER_H } from '@/shared/constants'
import {
  getHeaderAvatar,
  getHeaderActions,
  invokeHeaderAction,
  invokeHeaderAvatar,
  onHeaderActionsChanged,
  onHeaderAvatarChanged,
  setSettingsVisible,
  type HeaderActionInfo,
  type HeaderAvatarInfo,
} from '@/shared/api'
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

function getAvatarFallback(avatar: HeaderAvatarInfo): string {
  const source = avatar.displayInitial?.trim() || avatar.displayName?.trim()
  if (!source) return '?'
  return Array.from(source)[0] ?? '?'
}

function HeaderAvatar({ avatar }: { avatar: HeaderAvatarInfo }) {
  const [avatarFailed, setAvatarFailed] = React.useState(false)

  React.useEffect(() => {
    setAvatarFailed(false)
  }, [avatar.avatarUrl])

  const label = avatar.tooltip ?? avatar.displayName ?? '用户头像'
  const showImage = Boolean(avatar.avatarUrl) && !avatarFailed

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        void invokeHeaderAvatar()
      }}
      className={cn(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded border border-border',
        'bg-surface-thumb text-[13px] font-medium text-text transition-colors',
        'hover:border-border-subtle hover:bg-surface-3',
      )}
    >
      {showImage ? (
        <img
          src={avatar.avatarUrl}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setAvatarFailed(true)}
        />
      ) : (
        <span>{getAvatarFallback(avatar)}</span>
      )}
    </button>
  )
}

function HeaderActionButton({ action }: { action: HeaderActionInfo }) {
  const title = action.tooltip ?? action.label

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={action.disabled}
      title={title}
      onClick={() => {
        void invokeHeaderAction(action.id)
      }}
      className="h-8 max-w-24 px-2 text-[12px]"
    >
      <span className="truncate">{action.label}</span>
    </Button>
  )
}

function HeaderActionGroup({ actions }: { actions: HeaderActionInfo[] }) {
  if (actions.length === 0) return null

  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1.5 overflow-hidden">
      {actions.map((action) => (
        <HeaderActionButton key={action.id} action={action} />
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
  const [headerAvatar, setHeaderAvatar] = React.useState<HeaderAvatarInfo | null>(null)
  const [headerActions, setHeaderActions] = React.useState<HeaderActionInfo[]>([])

  React.useEffect(() => {
    let alive = true

    const refresh = () => {
      void getHeaderAvatar()
        .then((avatar) => {
          if (alive) setHeaderAvatar(avatar ?? null)
        })
        .catch(() => {
          if (alive) setHeaderAvatar(null)
        })
    }

    refresh()
    const unsubscribe = onHeaderAvatarChanged(refresh)

    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  React.useEffect(() => {
    let alive = true

    const refresh = () => {
      void getHeaderActions()
        .then((actions) => {
          if (alive) setHeaderActions(actions)
        })
        .catch(() => {
          if (alive) setHeaderActions([])
        })
    }

    refresh()
    const unsubscribe = onHeaderActionsChanged(refresh)

    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const disabled = compileStatus.status === 'compiling'
  const leftActions = headerActions.filter((action) => action.placement === 'left')
  const centerActions = headerActions.filter((action) => action.placement === 'center')
  const rightActions = headerActions.filter(
    (action) => !action.placement || action.placement === 'right',
  )

  return (
    <div className="flex flex-col shrink-0">
      <div
        className="flex items-center gap-3 px-2.5 bg-surface-2 border-b border-border shrink-0"
        style={{ height: HEADER_H }}
      >
        <div className="flex min-w-0 shrink-0 items-center gap-1.5 justify-start">
          {headerAvatar && <HeaderAvatar avatar={headerAvatar} />}
          {headerAvatar && <ToolbarDivider />}
          <LayoutVisibilityToggles layout={layout} />
          <HeaderActionGroup actions={leftActions} />
        </div>

        <div
          data-testid="project-toolbar-center"
          className="flex min-w-0 flex-1 items-center justify-center gap-1.5"
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

          <HeaderActionGroup actions={centerActions} />
        </div>

        <div className="flex min-w-0 shrink-0 items-center justify-end gap-1.5">
          <HeaderActionGroup actions={rightActions} />

          {/* Cluster 3: Layout controls, all inline toggles (no dropdown).
            Dropdowns were dropped because the editor WebContentsView
            renders above renderer-layer popovers in the OS stacking
            order, so a layout popover would be hidden behind it.
            - LayoutAlignmentToggle: single button that swaps simulator
              alignment between left and right.
            - LayoutDevtoolsPositionToggles: 3-button group for the
              devtools-position preset (inEditor / belowSimulator /
              rightOfSimulator). The at-least-one-visible guard lives
              in the store. */}
          <LayoutAlignmentToggle layout={layout} />
          <ToolbarDivider />
          <LayoutDevtoolsPositionToggles layout={layout} />

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
    </div>
  )
}
