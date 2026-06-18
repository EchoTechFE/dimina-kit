import { useCallback, useEffect, useState } from 'react'

/** Which side of the root row the simulator column sits on. */
export type SimulatorAlignment = 'left' | 'right'
/** Where the debug/devtools region sits relative to editor + simulator. */
export type DevtoolsPosition = 'inEditor' | 'belowSimulator' | 'rightOfSimulator'

export interface LayoutState {
  /**
   * Opaque, serialized `LayoutTree` JSON for the dock layout (or `null` to seed
   * the default). Kept as an opaque string so this store never imports the
   * electron-deck engine; `dock-layout.ts` owns parse/build.
   */
  dockTree?: string | null
  /**
   * The last toolbar layout PRESET applied (simulator side + devtools position).
   * Free-form dragging does NOT update these — they drive the preset toggles'
   * highlight + are the axes the preset rebuild reads. Defaults mirror
   * `buildDefaultDockTree` (simulator left, debug under the editor = inEditor).
   */
  simulatorAlignment: SimulatorAlignment
  devtoolsPosition: DevtoolsPosition
}

export const DEFAULT_LAYOUT_STATE: LayoutState = {
  dockTree: null,
  simulatorAlignment: 'left',
  devtoolsPosition: 'inEditor',
}

const STORAGE_KEY = 'dimina-devtools.layout.v1'

function load(): LayoutState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_LAYOUT_STATE
    const parsed = JSON.parse(raw) as Partial<LayoutState>
    return {
      dockTree: typeof parsed.dockTree === 'string' ? parsed.dockTree : null,
      simulatorAlignment: parsed.simulatorAlignment === 'right' ? 'right' : 'left',
      devtoolsPosition:
        parsed.devtoolsPosition === 'belowSimulator' || parsed.devtoolsPosition === 'rightOfSimulator'
          ? parsed.devtoolsPosition
          : 'inEditor',
    }
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
  setDockTree: (serialized: string | null) => void
  setSimulatorAlignment: (alignment: SimulatorAlignment) => void
  setDevtoolsPosition: (position: DevtoolsPosition) => void
}

export function useLayoutStore(): LayoutStoreApi {
  const [state, setState] = useState<LayoutState>(load)

  useEffect(() => {
    save(state)
  }, [state])

  const setDockTree = useCallback((serialized: string | null) => {
    setState((prev) => (prev.dockTree === serialized ? prev : { ...prev, dockTree: serialized }))
  }, [])

  const setSimulatorAlignment = useCallback((alignment: SimulatorAlignment) => {
    setState((prev) => (prev.simulatorAlignment === alignment ? prev : { ...prev, simulatorAlignment: alignment }))
  }, [])

  const setDevtoolsPosition = useCallback((position: DevtoolsPosition) => {
    setState((prev) => (prev.devtoolsPosition === position ? prev : { ...prev, devtoolsPosition: position }))
  }, [])

  return {
    state,
    setDockTree,
    setSimulatorAlignment,
    setDevtoolsPosition,
  }
}
