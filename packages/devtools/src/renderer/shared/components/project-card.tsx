import { useState } from 'react'
import { Button } from '@/shared/components/ui/button'
import { formatLastOpened } from '@/shared/lib/utils'
import type { Project } from '../types'

/** First grapheme of the project name, upper-cased for Latin script — used as
 * a text-logo fallback when the project has no real icon/thumbnail. */
function initialOf(name: string): string {
  const first = Array.from(name.trim())[0]
  return first ? first.toUpperCase() : '?'
}

export function ProjectCard({
  project: p,
  onOpen,
  onRemove,
  thumbnail,
}: {
  project: Project
  onOpen: (p: Project) => void
  onRemove: (p: Project) => void
  thumbnail?: string | null
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      className="relative flex flex-col min-w-[240px] w-full bg-surface border border-border rounded-[var(--qd-radius-xl)] overflow-hidden cursor-pointer transition-all duration-150 hover:border-[var(--qd-primary)] hover:shadow-[var(--qd-shadow-md)]"
      onClick={() => onOpen(p)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {thumbnail ? (
        <img
          src={thumbnail}
          className="aspect-square w-full object-cover object-top mb-[-24px] bg-bg"
          alt=""
        />
      ) : (
        <div className="aspect-square w-full mb-[-24px] bg-bg" />
      )}
      <div className="relative flex flex-col gap-3 px-4 pb-4 shrink-0">
        <div
          className="size-12 shrink-0 rounded-[var(--qd-radius-md)] bg-[var(--qd-primary)] flex items-center justify-center text-[20px] font-medium leading-none text-[color:var(--qd-on-solid)]"
          aria-hidden="true"
        >
          {initialOf(p.name)}
        </div>
        <div className="flex flex-col gap-1">
          <div
            className="text-[15px] font-medium leading-[22px] text-text truncate"
            title={p.name}
          >
            {p.name}
          </div>
          <div
            className="text-[12px] leading-4 text-text-secondary truncate"
            title={p.path}
          >
            {p.path}
          </div>
        </div>
        <div className="text-[12px] leading-4 text-text-secondary">
          {formatLastOpened(p.lastOpened)}
        </div>
      </div>
      {hovered && (
        <Button
          variant="danger"
          size="icon-sm"
          className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-overlay text-text-secondary leading-none hover:text-status-error hover:bg-danger-bg"
          onClick={(e) => {
            e.stopPropagation()
            onRemove(p)
          }}
          title="移除"
        >
          ×
        </Button>
      )}
    </div>
  )
}
