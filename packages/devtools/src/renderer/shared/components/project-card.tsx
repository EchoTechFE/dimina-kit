import { useState } from 'react'
import { Button } from '@/shared/components/ui/button'
import { formatLastOpened } from '@/shared/lib/utils'
import type { Project } from '../types'

export function ProjectCard({
  project: p,
  onOpen,
  onRemove,
}: {
  project: Project
  onOpen: (p: Project) => void
  onRemove: (p: Project) => void
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      className="relative bg-surface border border-border rounded-lg overflow-hidden cursor-pointer transition-all duration-150 hover:border-accent hover:-translate-y-0.5"
      onClick={() => onOpen(p)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="h-20 bg-surface-thumb" />
      <div className="p-3">
        <div
          className="text-sm font-medium text-text-white mb-1 truncate"
          title={p.name}
        >
          {p.name}
        </div>
        <div
          className="text-[11px] text-text-secondary truncate"
          title={p.path}
        >
          {p.path}
        </div>
        <div className="text-[11px] text-text-dim mt-1.5">
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
