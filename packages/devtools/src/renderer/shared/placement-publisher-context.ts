import { createContext, useContext } from 'react'
import type { PlacementPublisher } from '@dimina-kit/electron-deck/client'
import type { DevtoolsExtra } from '../../shared/view-ids'

// The current top-level screen's single placement publisher (provided by
// ProjectRuntime for the project screen, ProjectListScreen for the list
// screen — each owns an independent publisher instance, though both draw
// their generation from the same shared sequence, see
// renderer-placement-generation.ts). Each native-view anchor (simulator /
// editor / console / host-toolbar / host-sidebar) writes its desired
// placement here instead of invoking a per-view IPC channel; the publisher
// coalesces one window-level snapshot per frame. null outside either screen
// (e.g. isolated component tests that don't drive placement).
export const PlacementPublisherContext =
  createContext<PlacementPublisher<DevtoolsExtra> | null>(null)

export function usePlacementPublisher(): PlacementPublisher<DevtoolsExtra> | null {
  return useContext(PlacementPublisherContext)
}
