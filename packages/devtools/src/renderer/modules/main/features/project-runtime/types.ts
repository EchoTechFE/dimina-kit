export type BuiltinRightPaneTabId = 'simulator' | 'wxml' | 'appdata' | 'storage'
export type RightPaneTabId = BuiltinRightPaneTabId | (string & {})

export interface RightPaneState {
  selected: RightPaneTabId
  simulatorVisible: boolean
}

export const DEFAULT_RIGHT_PANE_STATE = {
  selected: 'simulator',
  simulatorVisible: true,
} satisfies RightPaneState
