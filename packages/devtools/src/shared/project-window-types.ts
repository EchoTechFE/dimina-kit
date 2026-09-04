import type { WorkbenchHostInstance } from './types.js'

/**
 * One project window, handed to the host hooks that act on a single project:
 * `setupProjectWindow` on the way in and `onBeforeClose` on the way out.
 */
export interface ProjectWindowRef {
  /** Absolute path of the project this window was opened for. */
  path: string
  /** Display name the open supplied, when it supplied one. */
  name?: string
  /** The window itself. */
  window: import('electron').BrowserWindow
  /**
   * This window's own context — the one holding its session and views. Same
   * type as {@link WorkbenchHostInstance.context}, borrowed from there rather
   * than named again so this file keeps its single WorkbenchContext reference.
   */
  context: WorkbenchHostInstance['context']
}

/**
 * The project window being closed. Named separately from
 * {@link ProjectWindowRef} because `onBeforeClose` documents it under this
 * name; the shape is the same.
 */
export type ClosingProjectWindow = ProjectWindowRef

/** Overrides for the windows opened projects get, not for the project list. */
export interface ProjectWindowConfig {
  /**
   * Auto-show a project window on `ready-to-show`. Defaults to `true`.
   *
   * Independent of `window.autoShow`, which governs only the project-list
   * window: a host that keeps the list hidden behind its own startup flow
   * still wants the project windows opened afterwards to appear on screen.
   */
  autoShow?: boolean
}
