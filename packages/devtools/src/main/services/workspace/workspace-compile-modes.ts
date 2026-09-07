/**
 * Wires a `CompileModeStore` into `WorkspaceService` for whichever project is
 * currently open. Extracted out of workspace-service.ts to keep that file
 * under the repo's file-length ratchet — this is the sole owner of the
 * store's lifecycle (open/replace/dispose); `WorkspaceService` only forwards
 * to it.
 */

import { selectedMode, type CompileModeCommand } from '../../../shared/compile-mode-state.js'
import { compileConfigFromMode } from '../../../shared/compile-modes.js'
import type { CompileConfig } from '../../../shared/types.js'
import * as repo from '../projects/project-repository.js'
import type { ProjectsProvider } from '../projects/types.js'
import { createCompileModeAdapter } from './compile-mode-adapter.js'
import {
  openCompileModeStore,
  type CompileModeChange,
  type CompileModeSnapshot,
  type CompileModeStore,
} from './compile-mode-store.js'

export interface CompileModeManager {
  /**
   * Creates and returns a store for `projectPath` as a standalone handle —
   * it does NOT touch the current store or subscribe to `onChange`. The
   * caller owns the handle until it either passes it to `adopt` or disposes
   * it itself (e.g. because the open it belongs to was superseded).
   */
  open(projectPath: string): Promise<CompileModeStore>
  /**
   * Makes `store` the current one: disposes whatever was current (and its
   * subscription) first, then wires `store` up. The current store must only
   * ever change here, alongside the session it belongs to — never as a side
   * effect of merely opening one.
   */
  adopt(store: CompileModeStore): void
  /** Disposes the current store, if any. Safe to call when none is open. */
  disposeCurrent(): void
  /**
   * `projectPath` omitted returns the currently open project's snapshot
   * (for callers, like the popover, that don't track a project path of
   * their own); given, it must match the open store's project or this
   * throws — a caller that DOES know the path never silently reads another
   * project's modes.
   */
  getCompileModeState(projectPath?: string): CompileModeSnapshot
  applyCompileModeCommand(command: CompileModeCommand): Promise<CompileModeChange>
  getCompileConfig(projectPath: string): Promise<CompileConfig>
  /** Untouched by the store redesign — a direct provider passthrough. */
  saveCompileConfig(projectPath: string, config: CompileConfig): Promise<void>
}

export function createCompileModeManager(
  provider: ProjectsProvider,
  onChange: (change: CompileModeChange) => void,
): CompileModeManager {
  const adapter = createCompileModeAdapter(provider)
  let store: CompileModeStore | null = null
  let unsubscribe: (() => void) | null = null

  function disposeCurrent(): void {
    unsubscribe?.()
    unsubscribe = null
    store?.dispose()
    store = null
  }

  async function open(projectPath: string): Promise<CompileModeStore> {
    return openCompileModeStore({
      projectPath,
      load: () => adapter.getCompileModes(projectPath),
      persist: (stored) => adapter.saveCompileModes(projectPath, stored),
    })
  }

  function adopt(handle: CompileModeStore): void {
    disposeCurrent()
    store = handle
    unsubscribe = handle.onChange(onChange)
  }

  function getCompileModeState(projectPath?: string): CompileModeSnapshot {
    if (!store || (projectPath !== undefined && projectPath !== store.projectPath)) {
      throw new Error(`no compile-mode store open for ${projectPath ?? ''}`)
    }
    return store.get()
  }

  function applyCompileModeCommand(command: CompileModeCommand): Promise<CompileModeChange> {
    if (!store) return Promise.reject(new Error('no compile-mode store open'))
    return store.apply(command)
  }

  // Mirrors project-repository.ts's own getCompileConfig: 普通编译 (and any
  // selected mode that left its start page blank) resolves to an empty
  // startPage, filled in here with the project's real entry page rather than
  // a mini-program-only literal.
  async function getCompileConfig(projectPath: string): Promise<CompileConfig> {
    if (store && store.projectPath === projectPath) {
      const config = compileConfigFromMode(selectedMode(store.get().state))
      if (config.startPage) return config
      return { ...config, startPage: repo.getProjectPages(projectPath).entryPagePath }
    }
    return adapter.getCompileConfig(projectPath)
  }

  return {
    open,
    adopt,
    disposeCurrent,
    getCompileModeState,
    applyCompileModeCommand,
    getCompileConfig,
    saveCompileConfig: adapter.saveCompileConfig,
  }
}

/**
 * Opens a store handle for `projectPath` right after a compile succeeds,
 * WITHOUT making it current — the caller decides whether to `adopt` it once
 * it has confirmed (under the op lock) that its open is still the latest
 * one; a superseded open disposes the handle itself instead. On failure,
 * closes `session` (best-effort) and returns the error message. A session
 * that compiled but whose store failed to open must not be left running, so
 * this centralizes that cleanup for callers.
 */
export async function openCompileModeStoreAfterCompile(
  manager: CompileModeManager,
  projectPath: string,
  session: { close(): Promise<void> },
): Promise<{ store: CompileModeStore } | { error: string }> {
  try {
    const store = await manager.open(projectPath)
    return { store }
  } catch (err) {
    try {
      await session.close()
    } catch (closeErr) {
      console.warn('[workspace] closing session after compile-mode store open failure (non-fatal):', closeErr)
    }
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
