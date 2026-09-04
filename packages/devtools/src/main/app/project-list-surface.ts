import type { BrowserWindow } from 'electron'
import type { UpdateInfo } from '../../shared/types.js'
import { revealWindow } from './window-events.js'

/**
 * Narrow view of the context fields the project-list surface closes over —
 * structural, not `WorkbenchContext` (see eslint-workbench-context-gate) —
 * so the surface carries no dependency on the whole workbench.
 */
export interface ProjectListSurfaceContext {
  notify: { windowNavigateBack: () => void }
  views: { showUpdateDialog: (info: UpdateInfo) => void }
}

export interface ProjectListSurfaceDeps {
  window: BrowserWindow
  context: ProjectListSurfaceContext
}

export interface ProjectListSurface {
  revealProjectList: () => void
  showUpdate: (info: UpdateInfo) => void
}

/**
 * "回到项目列表" 和更新弹窗都属于列表窗口本身，而不是当时 activeContext() 恰好
 * 解析到的窗口——那个窗口可能是某个项目工作台。这里是两条路径共同的入口：
 * revealProjectList 把列表窗口带到前台并通知它自己的 context 刷新；showUpdate
 * 先做同一件事，再弹更新对话框，避免窗口还处于 hide() 状态时用户看不到弹窗。
 */
export function createProjectListSurface(deps: ProjectListSurfaceDeps): ProjectListSurface {
  const { window, context } = deps

  const revealProjectList = (): void => {
    revealWindow(window)
    context.notify.windowNavigateBack()
  }

  const showUpdate = (info: UpdateInfo): void => {
    revealProjectList()
    context.views.showUpdateDialog(info)
  }

  return { revealProjectList, showUpdate }
}
