import React from 'react'
import { Pencil, Plus } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { ScrollArea } from '@/shared/components/ui/scroll-area'
import { Separator } from '@/shared/components/ui/separator'
import type { CompileModes } from '@/shared/types'
import { NORMAL_COMPILE_INDEX, UNNAMED_MODE_LABEL } from '../../../shared/compile-modes'

/** Custom modes past this many get their own scroll region instead of growing the card. */
const LIST_MAX_HEIGHT = 'max-h-[280px]'

interface CompileModeMenuProps {
  modes: CompileModes
  /** What 普通编译 launches, shown as its subtitle. */
  entryPagePath: string
  /** The simulator's visible route; empty when nothing is running. */
  currentRoute: string
  onSelect: (index: number) => void
  onEdit: (index: number) => void
  onCreate: () => void
  onCreateFromCurrentPage: () => void
}

/**
 * One selectable mode. The whole row selects; the pencil (custom modes only)
 * opens the editor instead, so selecting stays a single click — the reason the
 * old single-form popover felt slow was that every launch went through a form.
 *
 * Selection is shown the way the rest of the app shows a chosen item — an
 * active surface plus a primary rule down the left edge — rather than a
 * permanently reserved checkmark column.
 */
function ModeRow(props: {
  label: string
  subtitle: string
  selected: boolean
  onSelect: () => void
  onEdit?: () => void
}) {
  const { label, subtitle, selected, onSelect, onEdit } = props
  return (
    <div
      className={`group relative flex items-center rounded-[var(--qd-radius-md)] ${
        selected ? 'bg-[var(--color-surface-active)]' : 'hover:bg-[var(--qd-muted)]'
      }`}
    >
      {selected && (
        <span
          aria-hidden="true"
          className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-[var(--qd-primary)]"
        />
      )}
      <button
        type="button"
        role="menuitemradio"
        aria-checked={selected}
        data-testid="compile-mode-row"
        data-mode-label={label}
        className="min-w-0 flex-1 appearance-none border-0 bg-transparent px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--qd-primary)] rounded-[var(--qd-radius-md)]"
        onClick={onSelect}
      >
        <span className="block truncate text-sm text-text">{label}</span>
        {subtitle && (
          <span className="block truncate text-xs text-text-secondary">{subtitle}</span>
        )}
      </button>
      {onEdit && (
        <Button
          variant="icon"
          size="icon-sm"
          // Kept out of the way until the row is the one being looked at, the
          // same reveal-on-hover the project cards use for their own pencil.
          className={`mr-1.5 shrink-0 transition-opacity ${
            selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
          }`}
          aria-label={`编辑 ${label}`}
          onClick={onEdit}
        >
          <Pencil className="size-3.5" />
        </Button>
      )}
    </div>
  )
}

function ActionRow(props: {
  label: string
  disabled?: boolean
  onClick: () => void
}) {
  const { label, disabled, onClick } = props
  return (
    <Button
      variant="ghost"
      size="sm"
      className="w-full justify-start gap-1.5 px-2.5 text-text-secondary"
      disabled={disabled}
      onClick={onClick}
    >
      <Plus className="size-3.5 shrink-0" />
      {label}
    </Button>
  )
}

/**
 * The compile-mode dropdown: 普通编译 plus the project's named modes, and the
 * two ways to add one. 普通编译 is a fixed entry — the app's own entry page,
 * default scene, no params — and has nothing to edit; customizing means
 * creating a named mode.
 */
export function CompileModeMenu(props: CompileModeMenuProps) {
  const {
    modes,
    entryPagePath,
    currentRoute,
    onSelect,
    onEdit,
    onCreate,
    onCreateFromCurrentPage,
  } = props

  return (
    <div className="flex flex-col gap-1" role="menu" aria-label="编译模式">
      <ModeRow
        label="普通编译"
        subtitle={entryPagePath}
        selected={modes.current === NORMAL_COMPILE_INDEX}
        onSelect={() => onSelect(NORMAL_COMPILE_INDEX)}
      />

      {modes.list.length > 0 && (
        <>
          <Separator className="my-0.5" />
          <ScrollArea className={LIST_MAX_HEIGHT}>
            <div className="flex flex-col gap-1 pr-1">
              {modes.list.map((mode, i) => (
                <ModeRow
                  key={i}
                  // The path is already the subtitle, so falling back to it for
                  // the title too would print the same string twice.
                  label={mode.name || UNNAMED_MODE_LABEL}
                  subtitle={mode.query ? `${mode.pathName}?${mode.query}` : mode.pathName}
                  selected={modes.current === i}
                  onSelect={() => onSelect(i)}
                  onEdit={() => onEdit(i)}
                />
              ))}
            </div>
          </ScrollArea>
        </>
      )}

      <Separator className="my-0.5" />

      <ActionRow label="添加编译模式" onClick={onCreate} />
      <ActionRow
        // Nothing is running (or the route hasn't been reported yet), so there
        // is no page to capture. The entry stays visible with its reason
        // spelled out, rather than being a greyed-out row that explains nothing.
        label={currentRoute ? '以当前页面新建' : '以当前页面新建（项目未运行）'}
        disabled={!currentRoute}
        onClick={onCreateFromCurrentPage}
      />
    </div>
  )
}
