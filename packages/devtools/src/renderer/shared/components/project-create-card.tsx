/**
 * "新建项目" card placed at the head of the project list. Renders as a
 * dashed-border placeholder card with a "+" glyph and a Chinese label, and
 * invokes its `onClick` handler when the user clicks anywhere on it.
 */
import * as React from 'react'

export function ProjectCreateCard(props: {
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-label="新建项目"
      className="relative bg-transparent border-2 border-dashed border-border rounded-lg overflow-hidden cursor-pointer transition-all duration-150 hover:border-accent hover:-translate-y-0.5 h-full min-h-[188px] flex flex-col items-center justify-center gap-2 text-text-secondary hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span className="text-3xl leading-none" aria-hidden="true">+</span>
      <span className="text-sm font-medium">新建项目</span>
    </button>
  )
}
