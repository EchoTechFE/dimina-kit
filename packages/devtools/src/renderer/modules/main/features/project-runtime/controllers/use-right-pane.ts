import {
  useCallback,
  useState,
} from 'react'
import type { RightPaneState, RightPaneTabId } from '../types'

export interface UseRightPaneProps {
  initialRightPane: RightPaneState
}

export interface RightPaneHookResult {
  rightPane: RightPaneState
  selectRightPane: (panelId: RightPaneTabId) => void
  toggleRightPaneVisible: () => void
}

/**
 * Pure React state for the right-pane tab selection. No IPC side-channel:
 * the Chromium DevTools overlay's visibility converges on the view anchor —
 * selecting a non-Console tab hides the DevTools placeholder (display:none),
 * the anchor re-measures and publishes a 0×0 rect, and the main process
 * removes the overlay child view (see `useViewAnchor` in project-runtime.tsx).
 */
export function useRightPane(props: UseRightPaneProps): RightPaneHookResult {
  const { initialRightPane } = props

  const [rightPane, setRightPane] = useState<RightPaneState>(initialRightPane)

  const selectRightPane = useCallback(
    (panelId: RightPaneTabId) => {
      setRightPane({ selected: panelId, simulatorVisible: true })
    },
    [],
  )

  const toggleRightPaneVisible = useCallback(() => {
    setRightPane((prev) => ({
      ...prev,
      simulatorVisible: !prev.simulatorVisible,
    }))
  }, [])

  return {
    rightPane,
    selectRightPane,
    toggleRightPaneVisible,
  }
}
