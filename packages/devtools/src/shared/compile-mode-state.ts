/**
 * In-memory compile-mode model: selection tracks a minted id, not an index
 * into a list. Storage (`CompileModes`, WeChat's `condition.miniprogram`
 * shape) stays index-based so `project.config.json` keeps round-tripping —
 * `stateFromStored`/`storedFromState` are the only two places index
 * arithmetic happens at all. Everywhere else (in particular
 * `applyCompileModeCommand`) only ever compares/reassigns ids, so deleting or
 * reordering entries can never select the wrong mode by shifting a stale
 * index onto it.
 */

import {
  NORMAL_COMPILE_INDEX,
  normalizeCompileModes,
  type CompileMode,
  type CompileModes,
} from './compile-modes.js'

export type CompileModeId = string

export interface CompileModeEntry {
  id: CompileModeId
  mode: CompileMode
}

export interface CompileModeState {
  /** `null` selects 普通编译. */
  selectedId: CompileModeId | null
  entries: CompileModeEntry[]
}

export type MintId = () => CompileModeId

/** An empty model — no custom modes, 普通编译 selected. */
export function emptyCompileModeState(): CompileModeState {
  return { selectedId: null, entries: [] }
}

/**
 * Build the in-memory state from whatever is on disk, minting a fresh id for
 * each surviving entry in list order. Selection is carried across as the
 * entry's identity (the freshly minted id), not the raw numeric `current` —
 * `normalizeCompileModes` may have already remapped `current` when dropping
 * a malformed earlier entry, so the id assigned here already points at the
 * same data the stored `current` named.
 */
export function stateFromStored(raw: unknown, mintId: MintId): CompileModeState {
  const stored = normalizeCompileModes(raw)
  const entries = stored.list.map((mode) => ({ id: mintId(), mode }))
  const selectedId = stored.current >= 0 && stored.current < entries.length
    ? entries[stored.current].id
    : null
  return { selectedId, entries }
}

/** Project the in-memory state back into the on-disk index-based shape. */
export function storedFromState(state: CompileModeState): CompileModes {
  const list = state.entries.map((entry) => entry.mode)
  const current = state.selectedId === null
    ? NORMAL_COMPILE_INDEX
    : state.entries.findIndex((entry) => entry.id === state.selectedId)
  return { current: current < 0 ? NORMAL_COMPILE_INDEX : current, list }
}

/** The selected entry's mode, or `null` for 普通编译 (including a ghost id). */
export function selectedMode(state: CompileModeState): CompileMode | null {
  if (state.selectedId === null) return null
  return state.entries.find((entry) => entry.id === state.selectedId)?.mode ?? null
}

export type CompileModeCommand =
  | { type: 'select'; id: CompileModeId | null }
  | { type: 'add'; mode: CompileMode }
  | { type: 'update'; id: CompileModeId; mode: CompileMode }
  | { type: 'remove'; id: CompileModeId }

export interface CompileModeApplyResult {
  state: CompileModeState
  relaunch: boolean
}

/** A `CompileModeStore`'s current contents, tagged with a monotonic revision so a stale fetch racing a push can be told apart from a fresher one. */
export interface CompileModeSnapshot {
  revision: number
  state: CompileModeState
}

/** A snapshot plus whether the change affects what's currently running, for `RendererNotifier.compileModesChanged` pushes. */
export interface CompileModeChange extends CompileModeSnapshot {
  relaunch: boolean
}

/**
 * Interpret one command against the current state. `relaunch` reports
 * whether the running configuration changed, so a caller only restarts the
 * simulator when the selected mode itself moved. A command that names an id
 * nothing matches is a no-op and returns the SAME state reference (not a
 * copy) so a caller can cheaply tell "nothing changed" from "changed".
 */
export function applyCompileModeCommand(
  state: CompileModeState,
  command: CompileModeCommand,
  mintId: MintId,
): CompileModeApplyResult {
  switch (command.type) {
    case 'select': {
      if (command.id === null) {
        return { state: { ...state, selectedId: null }, relaunch: true }
      }
      if (!state.entries.some((entry) => entry.id === command.id)) {
        return { state, relaunch: false }
      }
      return { state: { ...state, selectedId: command.id }, relaunch: true }
    }
    case 'add': {
      const entry: CompileModeEntry = { id: mintId(), mode: command.mode }
      return {
        state: { selectedId: entry.id, entries: [...state.entries, entry] },
        relaunch: true,
      }
    }
    case 'update': {
      const index = state.entries.findIndex((entry) => entry.id === command.id)
      if (index < 0) {
        const entry: CompileModeEntry = { id: mintId(), mode: command.mode }
        return {
          state: { selectedId: entry.id, entries: [...state.entries, entry] },
          relaunch: true,
        }
      }
      const entries = [...state.entries]
      entries[index] = { id: command.id, mode: command.mode }
      return {
        state: { ...state, entries },
        relaunch: state.selectedId === command.id,
      }
    }
    case 'remove': {
      if (!state.entries.some((entry) => entry.id === command.id)) {
        return { state, relaunch: false }
      }
      const entries = state.entries.filter((entry) => entry.id !== command.id)
      const wasSelected = state.selectedId === command.id
      return {
        state: { selectedId: wasSelected ? null : state.selectedId, entries },
        relaunch: wasSelected,
      }
    }
  }
}
