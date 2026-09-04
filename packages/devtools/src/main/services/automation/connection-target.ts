import type { WindowService } from '../window-service.js'
import type { WorkspaceService } from '../workspace/workspace-service.js'

/** The slice of a window context that decides where a connection's commands go. */
export interface TargetContext {
  windows: Pick<WindowService, 'mainWindow'>
  workspace: Pick<WorkspaceService, 'hasActiveSession'>
}

/**
 * The project window one automation connection acts on.
 *
 * The active context follows window focus, so resolving it afresh per message
 * would let a click on another project's window redirect a script that is
 * already driving one — the script does nothing wrong and its commands land
 * somewhere else. A connection therefore PINS the first context it reaches
 * that has a session and keeps it for the rest of its life. Which window a
 * connection drives is decided by what it reached first, never by what the
 * user is looking at.
 *
 * Nothing is pinned before a project window exists: a client may connect at
 * boot and open a project afterwards, so until a context with a session shows
 * up every use resolves the active one (the project list, which drives
 * nothing). Pinning the list window would tie the connection to a window that
 * can never run a command.
 */
export interface ConnectionTarget<T extends TargetContext> {
  /**
   * The context to run a command against. Throws once the pinned window is
   * gone, so a connection whose project was closed fails loudly instead of
   * sliding onto whichever project happens to be open now.
   */
  resolve(): T
  /** The same target, but null instead of a throw once its window is gone. */
  peek(): T | null
}

export function createConnectionTarget<T extends TargetContext>(
  getCtx: () => T,
): ConnectionTarget<T> {
  let pinned: T | null = null

  // The window, not the session, is what a connection is pinned to: closing
  // the project inside a window (`Tool.close`) leaves that window able to open
  // another, while destroying the window ends the connection's target for good.
  const isGone = (ctx: T): boolean => {
    const win = ctx.windows.mainWindow
    return !win || win.isDestroyed()
  }

  const current = (): T | null => {
    if (pinned) return isGone(pinned) ? null : pinned
    const ctx = getCtx()
    if (ctx.workspace.hasActiveSession()) pinned = ctx
    return ctx
  }

  return {
    peek: current,
    resolve() {
      const ctx = current()
      if (!ctx) {
        throw new Error(
          'The project window this connection was driving has been closed. Reconnect to drive another project.',
        )
      }
      return ctx
    },
  }
}
