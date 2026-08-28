import { useEffect, useMemo, useState, type ComponentProps } from 'react'
import {
  onHostSidebarWidthChanged,
  getHostSidebarWidth,
  onHostSidebarCategorySelected,
} from '@/shared/api'
import { PlacementPublisherContext } from '@/shared/placement-publisher-context'
import { useHostSlotExtent, useScreenPlacementPublisher } from '@/shared/host-slot-hooks'
import { ProjectList } from '@/shared/components/project-list'
import { HOST_SIDEBAR_DEFAULT_WIDTH } from '@/shared/constants'
import { useViewAnchor } from '@dimina-kit/view-anchor'
import { VIEW_ID, VIEW_LAYER } from '../../../../../shared/view-ids'
import type { ProjectType } from '@/shared/types'

// `category` is owned by this screen (derived from the sidebar selection
// below), not by callers — excluded from the external prop surface.
type ProjectListProps = Omit<ComponentProps<typeof ProjectList>, 'category'>

/**
 * Wraps the (purely presentational) `ProjectList` with the host-controllable
 * sidebar slot on its inline axis — the project-list-page counterpart to
 * `ProjectRuntime`'s host-toolbar strip on the block axis. See that
 * component's doc-comment for the dynamic-extent loop this mirrors:
 * sidebar WCV advertises intrinsic width → main pushes it here as
 * `HostSidebarWidthChanged` → the placeholder div resizes → the forward
 * anchor re-measures → main re-overlays the WCV.
 */
export function ProjectListScreen(props: ProjectListProps) {
  const publisher = useScreenPlacementPublisher()

  // Seeded with the default rail's own known width, NOT 0 — main always loads
  // that rail into the slot itself (app.ts), and a 0 seed here would be a
  // structural deadlock rather than a slower-resolving initial value. See
  // `useHostSlotExtent` for the cycle. Any real width (this rail's own later
  // report, or a downstream replacement's) still arrives and overwrites it.
  const hostSidebarWidth = useHostSlotExtent(
    HOST_SIDEBAR_DEFAULT_WIDTH,
    onHostSidebarWidthChanged,
    getHostSidebarWidth,
  )

  // Category selected in the host-sidebar's content (devtools' own default
  // icon rail, or a downstream replacement sending on the same channel).
  // Push-only — see `onHostSidebarCategorySelected`'s doc-comment for why no
  // mount-time replay is needed, unlike the width channel above.
  const [selectedCategory, setSelectedCategory] = useState<ProjectType>('miniprogram')
  useEffect(() => onHostSidebarCategorySelected(setSelectedCategory), [])

  // Absent `type` predates mini-game support — treat as 'miniprogram' (see
  // `Project.type`'s doc-comment in shared/types.ts).
  const filteredProjects = useMemo(
    () => props.projects.filter((p) => (p.type ?? 'miniprogram') === selectedCategory),
    [props.projects, selectedCategory],
  )

  const hostSidebarAnchorRef = useViewAnchor({
    present: hostSidebarWidth > 0,
    publish: (bounds) => {
      const visible = hostSidebarWidth > 0 && bounds.width > 0 && bounds.height > 0
      publisher.set({
        viewId: VIEW_ID.hostSidebar,
        placement: visible ? { visible: true, bounds } : { visible: false },
        layer: VIEW_LAYER.hostSidebar,
      })
    },
    deps: [hostSidebarWidth, publisher],
  })

  return (
    <PlacementPublisherContext.Provider value={publisher}>
      <div className="flex h-screen">
        {/*
          Placeholder reserving space for the host-controllable sidebar WCV,
          on the inline (width) axis instead of ProjectToolbar's block
          (height) axis. The flex row pushes the project list over
          automatically — no offset math anywhere.
        */}
        <div
          ref={hostSidebarAnchorRef}
          style={{ width: hostSidebarWidth }}
          className="shrink-0 h-full"
          data-area="host-sidebar"
        />
        <div className="flex-1 min-w-0">
          <ProjectList {...props} projects={filteredProjects} category={selectedCategory} />
        </div>
      </div>
    </PlacementPublisherContext.Provider>
  )
}
