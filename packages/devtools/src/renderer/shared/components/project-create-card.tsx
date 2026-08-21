/**
 * "新建小程序" card placed at the head of the project list. Renders as a
 * dashed-border placeholder card with a "+" glyph and a Chinese label, and
 * invokes its `onClick` handler when the user clicks anywhere on it.
 */
import * as React from 'react'
import { Plus } from 'lucide-react'

export function ProjectCreateCard(props: {
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-label="新建小程序"
      className="relative min-w-[240px] min-h-[240px] w-full bg-surface border border-dashed border-border rounded-[var(--qd-radius-lg)] overflow-hidden cursor-pointer transition-colors duration-150 hover:border-[var(--qd-primary)] flex flex-col items-center justify-center gap-3 text-text-secondary hover:text-[var(--qd-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--qd-primary)]"
    >
      <Plus className="size-10" aria-hidden="true" strokeWidth={1.5} />
      <span className="text-[13px] font-medium">新建小程序</span>
    </button>
  )
}
