import {
  useCallback,
  useState,
} from 'react'
import type { RefObject } from 'react'
import {
  selectSimulatorPanel,
  setSimulatorVisible,
} from '@/shared/api'
import type { RightPaneState, RightPaneTabId } from '../types'

export interface UseRightPaneProps {
  initialRightPane: RightPaneState
  simPanelWidthRef: RefObject<number>
}

export interface RightPaneHookResult {
  rightPane: RightPaneState
  selectRightPane: (panelId: RightPaneTabId) => void
  toggleRightPaneVisible: () => void
}

export function useRightPane(props: UseRightPaneProps): RightPaneHookResult {
  const { initialRightPane, simPanelWidthRef } = props

  const [rightPane, setRightPane] = useState<RightPaneState>(initialRightPane)

  const syncRightPane = useCallback(
    (next: RightPaneState, width: number) => {
      if (next.selected === 'simulator') {
        if (next.simulatorVisible) {
          void selectSimulatorPanel()
          return
        }
        void setSimulatorVisible(false, width)
        return
      }
      void setSimulatorVisible(false, width)
    },
    [],
  )

  const selectRightPane = useCallback(
    (panelId: RightPaneTabId) => {
      const next: RightPaneState = { selected: panelId, simulatorVisible: true }
      setRightPane(next)
      syncRightPane(next, simPanelWidthRef.current!)
    },
    [syncRightPane, simPanelWidthRef],
  )

  const toggleRightPaneVisible = useCallback(() => {
    setRightPane((prev) => {
      const next: RightPaneState = {
        ...prev,
        simulatorVisible: !prev.simulatorVisible,
      }
      syncRightPane(next, simPanelWidthRef.current!)
      return next
    })
  }, [syncRightPane, simPanelWidthRef])

  return {
    rightPane,
    selectRightPane,
    toggleRightPaneVisible,
  }
}
