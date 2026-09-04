import type { BrowserWindow } from 'electron'
import type { MenuContext, WorkbenchAppConfig } from '../../shared/types.js'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'
import type { RendererNotifier } from '../services/notifications/renderer-notifier.js'
import { installAppMenu } from '../menu/index.js'

/** Narrow view of the context fields the menu surface closes over. */
export interface MenuHostContext {
  appName: string
  workspace: WorkspaceService
  openSettings: () => Promise<void>
  notify: RendererNotifier
}

/**
 * Build the hand-written narrow `MenuContext` a host menu builder receives —
 * explicit construction (not clone+delete), so the runtime object carries
 * EXACTLY the contract members and nothing else. Every member is a lazy
 * closure over the live context: a host monkey-patch of
 * `context.workspace.openProject` (the documented permission-gate pattern)
 * still intercepts calls made through this menu surface.
 *
 * The context is resolved per call, never captured: the menu is installed once
 * before any project exists, and a project lives in its own window, so a menu
 * item run later must reach the window the user is actually in.
 */
function toMenuContext(
  activeContext: () => MenuHostContext,
  revealProjectList: () => void,
): MenuContext {
  return {
    get appName() { return activeContext().appName },
    workspace: {
      hasActiveSession: () => activeContext().workspace.hasActiveSession(),
      getProjectPath: () => activeContext().workspace.getProjectPath(),
      openProject: (projectPath) => activeContext().workspace.openProject(projectPath),
      closeProject: () => activeContext().workspace.closeProject(),
      getSession: () => activeContext().workspace.getSession(),
    },
    openSettings: () => activeContext().openSettings(),
    notify: {
      projectStatus: (payload) => activeContext().notify.projectStatus(payload),
      // A project opens in its own window, so "back to the project list" is
      // no longer a screen change inside one window — it brings the list
      // window forward. That window owns its own context, which may not be
      // `activeContext()` (a project window can be the active one), so this
      // routes through the injected surface instead of notifying whatever is
      // currently active.
      windowNavigateBack: () => revealProjectList(),
    },
  }
}

export function installMenu(
  config: WorkbenchAppConfig,
  mainWindow: BrowserWindow,
  activeContext: () => MenuHostContext,
  revealProjectList: () => void,
): void {
  // Menu: use host-provided builder or fall back to default. Both consume the
  // same narrow MenuContext, so the built-in menu proves the hand-written
  // contract covers the real internal consumption.
  const menuContext = toMenuContext(activeContext, revealProjectList)
  if (config.menuBuilder) {
    config.menuBuilder(mainWindow, menuContext)
  } else {
    installAppMenu(menuContext)
  }
}
