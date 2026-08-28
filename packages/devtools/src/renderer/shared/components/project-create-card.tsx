/**
 * "新建小程序" card placed at the head of the project list. Renders as a
 * dashed-border placeholder card with a "+" glyph and a Chinese label, and
 * invokes its `onClick` handler when the user clicks anywhere on it.
 *
 * It is laid out from the same `ProjectCardMedia` + `ProjectCardFooter` blocks
 * a real project card is built from, with the footer left empty. Sizing it on
 * its own (rather than letting the grid row stretch it) is what keeps it as
 * tall as its neighbours in an EMPTY list, where there is no neighbour to
 * stretch against — otherwise the first card a new user sees is a short,
 * collapsed box. The "+" and the label sit in an overlay so the empty footer
 * does not push them off-centre.
 */
import * as React from 'react'
import { Plus } from 'lucide-react'
import { ProjectCardFooter, ProjectCardMedia } from './project-card'
import { PROJECT_TYPE_LABEL, type ProjectType } from '../types'

export function ProjectCreateCard(props: {
  onClick: () => void
  category: ProjectType
}): React.ReactElement {
  const label = `新建${PROJECT_TYPE_LABEL[props.category]}`
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-label={label}
      data-qd-card
      className="group relative flex flex-col min-w-[calc(var(--qd-card-w-ref)*1px)] w-full bg-surface border border-dashed border-border rounded-[var(--qd-radius-lg)] overflow-hidden cursor-pointer transition-colors duration-150 hover:border-[var(--qd-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--qd-primary)]"
    >
      <ProjectCardMedia />
      <ProjectCardFooter />
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-[calc(12*var(--qd-card-u))] text-text-secondary transition-colors duration-150 group-hover:text-[var(--qd-primary)]">
        <Plus
          className="size-[calc(40*var(--qd-card-u))]"
          aria-hidden="true"
          strokeWidth={1.5}
        />
        <span className="text-[calc(13*var(--qd-card-u))] font-medium">{label}</span>
      </span>
    </button>
  )
}
