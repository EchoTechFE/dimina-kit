/**
 * Resolving the project window an MCP call is aimed at.
 *
 * A project lives in its own window and every window keeps its own
 * session-status store, so `project_open` can only report the truth if it
 * awaits the store of the window it just opened. Reading the app-active
 * window's store instead times out on a first open (that window never compiles
 * this project) and can return another project's rebuild as this one's result.
 * The other tools have no window of their own to point at, so they take the
 * active one — once per call, as a whole.
 */

import type { SessionStatusStore } from '../workspace/session-status-store.js'
import type { McpProjectTarget } from './tools/project-tools.js'

/** The status surface `project_open` reports from: one window's own state. */
export interface McpProjectStatusSource {
  workspace: {
    getProjectPath(): string
    hasActiveSession(): boolean
  }
  sessionStatus: SessionStatusStore
}

export interface McpOpenedProject extends McpProjectStatusSource {
  /**
   * Generation guard for awaiting this open's compile. A window built by the
   * open reports 0, so its empty store's initial 'idle' is not mistaken for a
   * finished compile. A window that was already showing the project reports
   * `undefined`: focusing it triggers no compile, so its current settled state
   * IS the answer, and waiting for a newer one would hang.
   */
  afterGeneration?: number
}

interface OpenedWindow<W> {
  window: W
  context: McpProjectStatusSource
}

export interface OpenForMcpDeps<W> {
  /** Open the project in its own window (or focus the one already showing it). */
  open: (project: { name?: string; path: string }) => Promise<W>
  /** Every live project window, so the opened one can be matched by identity. */
  list: () => OpenedWindow<W>[]
}

/**
 * Build the `requestOpenInUi` the MCP project tools drive: open the project
 * and hand back the window it landed in, together with the generation guard
 * for awaiting that window's compile.
 */
export function createOpenForMcp<W>(
  deps: OpenForMcpDeps<W>,
): (project: { name: string; path: string }) => Promise<McpOpenedProject> {
  return async (project) => {
    // Sampled BEFORE the open: a window that already exists carries a previous
    // compile's history, and only a state recorded after this point can be
    // this open's result. Keyed by context identity, so a window rebuilt
    // during the open is correctly seen as new.
    const before = new Map(
      deps.list().map((w) => [w.context, w.context.sessionStatus.get().generation] as const),
    )
    const window = await deps.open(project)
    const opened = deps.list().find((w) => w.window === window)
    if (!opened) throw new Error(`the window opened for ${project.path} is already gone`)

    return {
      workspace: opened.context.workspace,
      sessionStatus: opened.context.sessionStatus,
      afterGeneration: before.has(opened.context) ? undefined : 0,
    }
  }
}

/**
 * The window-context fields an MCP project call reads. Structural, so this
 * module stays independent of the workbench context that satisfies it.
 */
export interface McpTargetContext {
  workspace: McpProjectTarget['workspace']
  sessionStatus: McpProjectTarget['sessionStatus']
  compileLogBuffer: McpProjectTarget['compileLogs']
}

export interface TargetForMcpDeps<W, C extends McpTargetContext> {
  /** Every live project window, so the active one can be matched by context. */
  list: () => { window: W; context: C }[]
  /** The context of the project window the user is working in. */
  activeContext: () => C
  /** Take one window down the way a user-driven close does. */
  close: (window: W) => void
}

/**
 * Build the `currentProject` the MCP project tools drive: resolve the project
 * window the user is working in NOW and hand back every surface a tool call
 * needs, all bound to that one window.
 *
 * Tool calls yield — `closeProject()` awaits a teardown, `waitForSettled()`
 * awaits a compile — and the user can focus another project meanwhile.
 * Re-resolving afterwards reports one project's compile as another's, or
 * closes the window they just moved to while the window whose session was torn
 * down stays on screen, empty. The active context can also be the project
 * list, which owns no project window: closing then does nothing.
 */
export function createTargetForMcp<W, C extends McpTargetContext>(
  deps: TargetForMcpDeps<W, C>,
): () => McpProjectTarget {
  return () => {
    const context = deps.activeContext()
    const owner = deps.list().find((w) => w.context === context)
    return {
      workspace: context.workspace,
      sessionStatus: context.sessionStatus,
      compileLogs: context.compileLogBuffer,
      closeWindow: () => { if (owner) deps.close(owner.window) },
    }
  }
}
