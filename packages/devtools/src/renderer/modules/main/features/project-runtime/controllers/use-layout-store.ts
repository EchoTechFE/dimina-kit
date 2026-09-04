import { useCallback, useEffect, useRef, useState } from 'react'

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

/**
 * The pre-split single record, from when devtools showed every project in ONE
 * workbench window. Read-only from here on: it seeds any project that has no
 * record of its own, so an upgrading user keeps the layout they had. Nothing
 * writes or deletes it — a project consuming it would hand its own layout to
 * every other project that opens later, which is the shared-record bug again.
 */
const LEGACY_STORAGE_KEY = 'dimina-devtools.layout.v1'

/** Prefix of the per-project records; the suffix is `projectKey()`. */
const STORAGE_KEY_PREFIX = 'dimina-devtools.layout.p.'

/**
 * How many project records survive. Every project a user ever opens would
 * otherwise add one for the lifetime of the machine and eventually hit the
 * localStorage quota. Evicting the least recently saved keeps the projects
 * actually being worked on; an evicted project reopens on the default layout.
 */
const MAX_PROJECT_RECORDS = 24

/**
 * A persisted record: the layout plus the identity it belongs to and when it
 * was written. `projectPath` guards against a `projectKey` hash collision (two
 * paths landing on one key degrade to "no record", never to a shared layout);
 * `savedAt` is the eviction order.
 */
interface StoredLayout extends LayoutState {
  projectPath: string
  savedAt: number
}

/**
 * Storage key for a project. Project paths are unbounded in length and carry
 * arbitrary characters, so they are hashed rather than spliced into the key;
 * `StoredLayout.projectPath` re-checks identity on read. Mirrors the hash the
 * main process uses to fold a project path into its session partition key.
 */
function projectKey(projectPath: string): string {
  let h = 5381
  for (let i = 0; i < projectPath.length; i++) {
    h = ((h << 5) + h + projectPath.charCodeAt(i)) >>> 0
  }
  return `${STORAGE_KEY_PREFIX}${h.toString(36)}`
}

function sanitize(parsed: Partial<LayoutState>): LayoutState {
  return {
    dockTree: typeof parsed.dockTree === 'string' ? parsed.dockTree : null,
    simulatorAlignment: parsed.simulatorAlignment === 'right' ? 'right' : 'left',
    devtoolsPosition:
      parsed.devtoolsPosition === 'belowSimulator' || parsed.devtoolsPosition === 'rightOfSimulator'
        ? parsed.devtoolsPosition
        : 'inEditor',
  }
}

function readRecord(key: string): Partial<StoredLayout> | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Partial<StoredLayout>) : null
  } catch {
    return null
  }
}

/**
 * Hydrate a project's layout. An unidentified window (no project bound yet)
 * gets the defaults and never touches storage — falling back to one shared key
 * there would re-create the cross-project clobbering.
 */
function load(projectPath: string | null | undefined): LayoutState {
  if (!projectPath) return DEFAULT_LAYOUT_STATE
  const own = readRecord(projectKey(projectPath))
  if (own && own.projectPath === projectPath) return sanitize(own)
  return sanitize(readRecord(LEGACY_STORAGE_KEY) ?? {})
}

/**
 * Monotonic write stamp. `Date.now()` alone ties when several projects are
 * saved inside the same millisecond, which would make eviction order arbitrary
 * within a window; bumping past the last stamp keeps it strictly increasing.
 */
let lastSavedAt = 0

function save(projectPath: string | null | undefined, state: LayoutState) {
  if (!projectPath) return
  lastSavedAt = Math.max(Date.now(), lastSavedAt + 1)
  const record: StoredLayout = { ...state, projectPath, savedAt: lastSavedAt }
  try {
    window.localStorage.setItem(projectKey(projectPath), JSON.stringify(record))
  } catch {
    /* localStorage quota / disabled — silently fall back to in-memory */
    return
  }
  evictOldest()
}

/** Drop the oldest records down to `MAX_PROJECT_RECORDS`. */
function evictOldest() {
  try {
    const records: { key: string; savedAt: number }[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      if (!key?.startsWith(STORAGE_KEY_PREFIX)) continue
      const savedAt = readRecord(key)?.savedAt
      records.push({ key, savedAt: typeof savedAt === 'number' ? savedAt : 0 })
    }
    if (records.length <= MAX_PROJECT_RECORDS) return
    records.sort((a, b) => a.savedAt - b.savedAt)
    for (const { key } of records.slice(0, records.length - MAX_PROJECT_RECORDS)) {
      window.localStorage.removeItem(key)
    }
  } catch {
    /* storage disabled — nothing to reclaim */
  }
}

export interface LayoutStoreApi {
  state: LayoutState
  setDockTree: (serialized: string | null) => void
  setSimulatorAlignment: (alignment: SimulatorAlignment) => void
  setDevtoolsPosition: (position: DevtoolsPosition) => void
}

/**
 * Dock layout for ONE project, persisted per project.
 *
 * Every project window loads the same `file://` origin and therefore shares one
 * localStorage, so the record has to be keyed by the project the window is
 * showing — otherwise two open projects overwrite each other's layout and any
 * project reopens with whichever window saved last. `projectPath` is the
 * identity: the window is opened for a path and has it before the first render,
 * whereas the manifest `appId` only arrives once the session opens, which is
 * after the dock model is seeded from this state.
 */
export function useLayoutStore(projectPath: string | null | undefined): LayoutStoreApi {
  const [state, setState] = useState<LayoutState>(() => load(projectPath))
  const loadedFor = useRef(projectPath)

  useEffect(() => {
    // A window that swaps projects in place must re-hydrate before it persists,
    // or the previous project's layout would be written under the new identity.
    if (loadedFor.current !== projectPath) {
      loadedFor.current = projectPath
      setState(load(projectPath))
      return
    }
    save(projectPath, state)
  }, [projectPath, state])

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
