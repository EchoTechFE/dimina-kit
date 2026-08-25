import { useEffect, useMemo, useState, type ComponentProps } from 'react'
import { onHostSidebarWidthChanged, getHostSidebarWidth, publishPlacementSnapshot } from '@/shared/api'
import { PlacementPublisherContext } from '@/shared/placement-publisher-context'
import { nextPlacementGeneration } from '@/shared/renderer-placement-generation'
import { ProjectList } from '@/shared/components/project-list'
import { useViewAnchor } from '@dimina-kit/view-anchor'
import { createPlacementPublisher, type PlacementPublisher } from '@dimina-kit/electron-deck/client'
import { VIEW_ID, VIEW_LAYER } from '../../../../../shared/view-ids'
import type { DevtoolsExtra } from '../../../../../shared/view-ids'

type ProjectListProps = ComponentProps<typeof ProjectList>

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
  const [generation] = useState(() => nextPlacementGeneration())
  const publisher = useMemo<PlacementPublisher<DevtoolsExtra>>(
    () => createPlacementPublisher<DevtoolsExtra>({
      generation,
      publish: (snapshot) => { void publishPlacementSnapshot(snapshot) },
    }),
    [generation],
  )
  useEffect(() => () => publisher.dispose(), [publisher])

  const [hostSidebarWidth, setHostSidebarWidth] = useState(0)
  useEffect(() => {
    // Mount-time REPLAY — same TOCTOU-guarded subscribe-then-pull pattern as
    // ProjectRuntime's host-toolbar height effect: subscribe FIRST so a push
    // landing between pull and subscribe isn't lost, then pull the
    // main-retained width in case it was pushed before this screen mounted.
    let pushReceived = false
    const unsubscribe = onHostSidebarWidthChanged((width) => {
      pushReceived = true
      setHostSidebarWidth(width)
    })
    void getHostSidebarWidth().then((width) => {
      if (pushReceived) return
      if (typeof width === 'number') setHostSidebarWidth(width)
    })
    return unsubscribe
  }, [])

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
          <ProjectList {...props} />
        </div>
      </div>
    </PlacementPublisherContext.Provider>
  )
}
