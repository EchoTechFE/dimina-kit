import { createContext, useContext } from 'react'
import type { PlacementPublisher } from '@dimina-kit/electron-deck/client'
import type { DevtoolsExtra } from '../../../../../shared/view-ids'

// The project window's single placement publisher, provided by ProjectRuntime.
// Each native-view anchor (simulator / editor / console / host-toolbar) writes
// its desired placement here instead of invoking a per-view IPC channel; the
// publisher coalesces one window-level snapshot per frame. null outside a
// ProjectRuntime (e.g. isolated component tests that don't drive placement).
export const PlacementPublisherContext =
  createContext<PlacementPublisher<DevtoolsExtra> | null>(null)

export function usePlacementPublisher(): PlacementPublisher<DevtoolsExtra> | null {
  return useContext(PlacementPublisherContext)
}
