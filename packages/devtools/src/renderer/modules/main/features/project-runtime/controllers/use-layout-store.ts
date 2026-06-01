import { useCallback, useEffect, useState } from 'react'

export type SimulatorAlignment = 'left' | 'right'
export type DevtoolsPosition = 'inEditor' | 'belowSimulator' | 'rightOfSimulator'

export interface LayoutState {
  simulatorVisible: boolean
  editorVisible: boolean
  debugVisible: boolean
  simulatorAlignment: SimulatorAlignment
  devtoolsPosition: DevtoolsPosition
}

export const DEFAULT_LAYOUT_STATE: LayoutState = {
  simulatorVisible: true,
  editorVisible: true,
  debugVisible: true,
  simulatorAlignment: 'left',
  devtoolsPosition: 'inEditor',
}

const STORAGE_KEY = 'dimina-devtools.layout.v1'

function load(): LayoutState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_LAYOUT_STATE
    const parsed = JSON.parse(raw) as Partial<LayoutState>
    const candidate: LayoutState = {
      simulatorVisible: typeof parsed.simulatorVisible === 'boolean' ? parsed.simulatorVisible : DEFAULT_LAYOUT_STATE.simulatorVisible,
      editorVisible: typeof parsed.editorVisible === 'boolean' ? parsed.editorVisible : DEFAULT_LAYOUT_STATE.editorVisible,
      debugVisible: typeof parsed.debugVisible === 'boolean' ? parsed.debugVisible : DEFAULT_LAYOUT_STATE.debugVisible,
      simulatorAlignment: parsed.simulatorAlignment === 'right' ? 'right' : 'left',
      devtoolsPosition:
        parsed.devtoolsPosition === 'belowSimulator' || parsed.devtoolsPosition === 'rightOfSimulator'
          ? parsed.devtoolsPosition
          : 'inEditor',
    }
    // Sanitize: a previously-persisted state where every panel was
    // toggled off (which the toggle guard prevents under normal use,
    // but a stale write or hand-edit could produce) would render an
    // empty window. Fall back to the default in that case.
    if (
      !candidate.simulatorVisible &&
      !candidate.editorVisible &&
      !candidate.debugVisible
    ) {
      return DEFAULT_LAYOUT_STATE
    }
    return candidate
  } catch {
    return DEFAULT_LAYOUT_STATE
  }
}

function save(state: LayoutState) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* localStorage quota / disabled — silently fall back to in-memory */
  }
}

export interface LayoutStoreApi {
  state: LayoutState
  visibleCount: number
  toggleSimulator: () => void
  toggleEditor: () => void
  toggleDebug: () => void
  setSimulatorAlignment: (alignment: SimulatorAlignment) => void
  setDevtoolsPosition: (position: DevtoolsPosition) => void
}

// At-least-one-visible guard mirroring WeChat DevTools: the panel currently
// holding the last `true` flag must not be toggled off. Returns the next
// state, leaving prev intact when the toggle would violate the guard.
function toggleVisible(prev: LayoutState, key: 'simulatorVisible' | 'editorVisible' | 'debugVisible'): LayoutState {
  const target = !prev[key]
  if (!target) {
    const otherCount = (prev.simulatorVisible ? 1 : 0) + (prev.editorVisible ? 1 : 0) + (prev.debugVisible ? 1 : 0) - (prev[key] ? 1 : 0)
    if (otherCount === 0) return prev
  }
  return { ...prev, [key]: target }
}

export function useLayoutStore(): LayoutStoreApi {
  const [state, setState] = useState<LayoutState>(load)

  useEffect(() => {
    save(state)
  }, [state])

  const toggleSimulator = useCallback(() => {
    setState((prev) => toggleVisible(prev, 'simulatorVisible'))
  }, [])
  const toggleEditor = useCallback(() => {
    setState((prev) => toggleVisible(prev, 'editorVisible'))
  }, [])
  const toggleDebug = useCallback(() => {
    setState((prev) => toggleVisible(prev, 'debugVisible'))
  }, [])
  const setSimulatorAlignment = useCallback((alignment: SimulatorAlignment) => {
    setState((prev) => (prev.simulatorAlignment === alignment ? prev : { ...prev, simulatorAlignment: alignment }))
  }, [])
  const setDevtoolsPosition = useCallback((position: DevtoolsPosition) => {
    setState((prev) => (prev.devtoolsPosition === position ? prev : { ...prev, devtoolsPosition: position }))
  }, [])

  const visibleCount = (state.simulatorVisible ? 1 : 0) + (state.editorVisible ? 1 : 0) + (state.debugVisible ? 1 : 0)

  return {
    state,
    visibleCount,
    toggleSimulator,
    toggleEditor,
    toggleDebug,
    setSimulatorAlignment,
    setDevtoolsPosition,
  }
}
