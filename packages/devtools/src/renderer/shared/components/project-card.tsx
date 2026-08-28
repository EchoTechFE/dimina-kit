import { type ReactNode, useEffect, useState } from 'react'
import { Pencil } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { formatLastOpened } from '@/shared/lib/utils'
import type { Project } from '../types'

/**
 * The square preview area a card opens with. Exported because a card's height
 * is `media + footer`, and the create card has to reach that same height on
 * its own: it is the only item in an empty list, so there is no sibling row
 * for the grid to stretch it against.
 *
 * Metrics are multiples of `--qd-card-u` (see design.css) rather than fixed
 * pixels, so the whole card scales with its column width instead of drifting
 * in aspect ratio as the elastic grid widens it.
 */
export function ProjectCardMedia({ children }: { children?: ReactNode }) {
  return (
    <div className="aspect-square w-full mb-[calc(-24*var(--qd-card-u))] overflow-hidden">
      {children}
    </div>
  )
}

/**
 * The metadata block under the preview — the other half of a card's height.
 * Every slot is optional: omitted rows keep their line box (a non-breaking
 * space) so a card with no metadata to show still measures the same as one
 * that has it. See `ProjectCardMedia` for why that matters.
 */
export function ProjectCardFooter({
  icon,
  iconUrl,
  name,
  path,
  meta,
}: {
  icon?: ReactNode
  /** When set, the icon tile shows this image instead of `icon`. */
  iconUrl?: string
  name?: string
  path?: string
  meta?: ReactNode
}) {
  return (
    <div className="relative flex flex-col gap-[calc(12*var(--qd-card-u))] px-[calc(16*var(--qd-card-u))] pb-[calc(16*var(--qd-card-u))] shrink-0">
      <ProjectCardIcon iconUrl={iconUrl} fallback={icon} />
      <div className="flex flex-col gap-[calc(4*var(--qd-card-u))]">
        <div
          className="text-[calc(15*var(--qd-card-u))] font-medium leading-[calc(22*var(--qd-card-u))] text-text truncate"
          title={name}
        >
          {name ?? ' '}
        </div>
        <div
          className="text-[calc(12*var(--qd-card-u))] leading-[calc(16*var(--qd-card-u))] text-text-secondary truncate"
          title={path}
        >
          {path ?? ' '}
        </div>
      </div>
      <div className="text-[calc(12*var(--qd-card-u))] leading-[calc(16*var(--qd-card-u))] text-text-secondary">
        {meta ?? ' '}
      </div>
    </div>
  )
}

/**
 * The square icon tile in a card's footer. With an `iconUrl` it shows that
 * image; otherwise (and after the image fails to load) it shows `fallback` —
 * the name-initial text logo — on the solid brand tile.
 *
 * The tile keeps its size and shape in both modes so a card does not reflow
 * when a project gains or loses an icon. The load-failure fallback matters
 * because the URL is user-typed and points at a remote host: without it a
 * typo or an offline host leaves a blank square with no way to tell it apart
 * from a project that simply has no icon.
 */
function ProjectCardIcon({
  iconUrl,
  fallback,
}: {
  iconUrl?: string
  fallback?: ReactNode
}) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [iconUrl])
  const showImage = !!iconUrl && !failed

  return (
    <div
      className={`size-[calc(48*var(--qd-card-u))] shrink-0 rounded-[var(--qd-radius-md)] overflow-hidden flex items-center justify-center text-[calc(20*var(--qd-card-u))] font-medium leading-none ${
        showImage
          ? 'bg-bg'
          : fallback
            ? 'bg-[var(--qd-primary)] text-[color:var(--qd-on-solid)]'
            : ''
      }`}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          src={iconUrl}
          alt=""
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        fallback
      )}
    </div>
  )
}

/** First grapheme of the project name, upper-cased for Latin script — used as
 * a text-logo fallback when the project has no real icon/thumbnail. */
function initialOf(name: string): string {
  const first = Array.from(name.trim())[0]
  return first ? first.toUpperCase() : '?'
}

export function ProjectCard({
  project: p,
  onOpen,
  onEdit,
  onRemove,
  thumbnail,
}: {
  project: Project
  onOpen: (p: Project) => void
  /** Omitted by hosts that don't expose the edit dialog — the pencil is then hidden. */
  onEdit?: (p: Project) => void
  onRemove: (p: Project) => void
  thumbnail?: string | null
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      data-qd-card
      className="relative flex flex-col min-w-[calc(var(--qd-card-w-ref)*1px)] w-full bg-surface border border-border rounded-[var(--qd-radius-xl)] overflow-hidden cursor-pointer transition-all duration-150 hover:border-[var(--qd-primary)] hover:shadow-[var(--qd-shadow-md)]"
      onClick={() => onOpen(p)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <ProjectCardMedia>
        {thumbnail ? (
          <img src={thumbnail} className="size-full object-cover object-top bg-bg" alt="" />
        ) : (
          <div className="size-full bg-bg" />
        )}
      </ProjectCardMedia>
      <ProjectCardFooter
        icon={initialOf(p.name)}
        iconUrl={p.iconUrl}
        name={p.name}
        path={p.path}
        meta={formatLastOpened(p.lastOpened)}
      />
      {hovered && (
        <div className="absolute top-1.5 right-1.5 flex items-center gap-1">
          {onEdit && (
            <Button
              size="icon-sm"
              className="w-5 h-5 rounded-full bg-overlay text-text-secondary leading-none hover:text-[var(--qd-primary)]"
              onClick={(e) => {
                e.stopPropagation()
                onEdit(p)
              }}
              title="编辑"
              aria-label={`编辑 ${p.name}`}
            >
              <Pencil className="size-3" aria-hidden="true" />
            </Button>
          )}
          <Button
            variant="danger"
            size="icon-sm"
            className="w-5 h-5 rounded-full bg-overlay text-text-secondary leading-none hover:text-status-error hover:bg-danger-bg"
            onClick={(e) => {
              e.stopPropagation()
              onRemove(p)
            }}
            title="移除"
          >
            ×
          </Button>
        </div>
      )}
    </div>
  )
}
