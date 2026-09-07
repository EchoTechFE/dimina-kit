/**
 * Single owner of one open project's compile modes: the only thing allowed
 * to read/write the persisted file and to advance the in-memory snapshot.
 * `apply()` calls are serialized through a queue so two commands issued
 * back-to-back never interleave their persists, and persist-before-adopt
 * means a write that fails on disk is never visible in `get()` or broadcast
 * to `onChange` listeners — memory never runs ahead of what's on disk.
 */

import {
  applyCompileModeCommand,
  stateFromStored,
  storedFromState,
  type CompileModeChange,
  type CompileModeCommand,
  type CompileModeSnapshot,
  type MintId,
} from '../../../shared/compile-mode-state.js'
import type { CompileModes } from '../../../shared/types.js'

// Re-exported so existing main-process import sites (including this file's
// own test) keep resolving unchanged — the renderer needs these too, so the
// canonical definitions live in shared/compile-mode-state.ts.
export type { CompileModeChange, CompileModeSnapshot }

export interface CompileModeStore {
  readonly projectPath: string
  get(): CompileModeSnapshot
  apply(command: CompileModeCommand): Promise<CompileModeChange>
  onChange(listener: (change: CompileModeChange) => void): () => void
  dispose(): void
}

let nextIdCounter = 0
function defaultMintId(): string {
  nextIdCounter += 1
  return `compile-mode-${nextIdCounter}`
}

export async function openCompileModeStore(input: {
  projectPath: string
  load(): Promise<unknown>
  persist(stored: CompileModes): Promise<void>
  mintId?: MintId
}): Promise<CompileModeStore> {
  const mintId = input.mintId ?? defaultMintId
  const raw = await input.load()

  let revision = 0
  let state = stateFromStored(raw, mintId)
  let disposed = false
  const listeners = new Set<(change: CompileModeChange) => void>()
  // Serializes apply() calls: each call chains onto this promise so the next
  // command's persist only starts after the previous one has fully settled.
  let queue: Promise<void> = Promise.resolve()

  function get(): CompileModeSnapshot {
    return { revision, state }
  }

  // Not `async` on purpose: an async function wrapping a returned promise
  // adds an extra microtask hop before a caller's `.then` fires, which is
  // enough to let the queue's OWN downstream continuation (chaining the next
  // apply()) run ahead of a caller that is racing to inspect order — this
  // function must return `run` itself so a caller's `.then` is attached
  // directly to it, same as the queue's internal continuation.
  function apply(command: CompileModeCommand): Promise<CompileModeChange> {
    if (disposed) {
      return Promise.reject(new Error('compile-mode store disposed'))
    }
    const run = queue.then(() => runApply(command))
    // Keep the queue alive even if this command rejects, so a later apply()
    // still runs instead of being stuck behind a broken link forever.
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function runApply(command: CompileModeCommand): Promise<CompileModeChange> {
    if (disposed) {
      throw new Error('compile-mode store disposed')
    }
    const result = applyCompileModeCommand(state, command, mintId)
    if (result.state === state) {
      // No-op: nothing to persist or broadcast.
      return { revision, state, relaunch: false }
    }
    await input.persist(storedFromState(result.state))
    state = result.state
    revision += 1
    const change: CompileModeChange = { revision, state, relaunch: result.relaunch }
    for (const listener of listeners) listener(change)
    return change
  }

  function onChange(listener: (change: CompileModeChange) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function dispose(): void {
    disposed = true
    listeners.clear()
  }

  return { projectPath: input.projectPath, get, apply, onChange, dispose }
}
