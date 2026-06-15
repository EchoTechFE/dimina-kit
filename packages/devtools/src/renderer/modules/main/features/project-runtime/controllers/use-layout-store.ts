import { useCallback, useEffect, useState } from 'react'

export interface LayoutState {
  /**
   * Opaque, serialized `LayoutTree` JSON for the dock layout (or `null` to seed
   * the default). Kept as an opaque string so this store never imports the
   * electron-deck engine; `dock-layout.ts` owns parse/build.
   */
  dockTree?: string | null
}

export const DEFAULT_LAYOUT_STATE: LayoutState = {
  dockTree: null,
}

const STORAGE_KEY = 'dimina-devtools.layout.v1'

function load(): LayoutState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_LAYOUT_STATE
    const parsed = JSON.parse(raw) as Partial<LayoutState>
    return {
      dockTree: typeof parsed.dockTree === 'string' ? parsed.dockTree : null,
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
}

export function useLayoutStore(): LayoutStoreApi {
  const [state, setState] = useState<LayoutState>(load)

  useEffect(() => {
    save(state)
  }, [state])

  const setDockTree = useCallback((serialized: string | null) => {
    setState((prev) => (prev.dockTree === serialized ? prev : { ...prev, dockTree: serialized }))
  }, [])

  return {
    state,
    setDockTree,
  }
}
