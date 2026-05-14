import type { CompileConfig, ProjectSession } from '../../../shared/types.js'
import type { WorkbenchContext } from '../workbench-context.js'
import * as repo from '../projects/project-repository.js'
import type {
  Project,
  ProjectPages,
  ProjectSettings,
} from '../projects/project-repository.js'
import {
  clearSimulatorServicewechatReferer,
  setSimulatorServicewechatReferer,
} from '../simulator/referer.js'
import { loadWorkbenchSettings } from '../settings/index.js'

/**
 * Result returned to the renderer after `project:open` finishes.
 * Mirrors the previous inline shape in ipc/session.ts so no
 * renderer-side change is required.
 */
export interface OpenProjectResult {
  success: boolean
  port?: number
  appInfo?: unknown
  error?: string
}

/**
 * The single source of truth for project + session + project-settings.
 *
 * Responsibilities:
 *  - list / add / remove projects (delegates to the repository module for fs)
 *  - open / close the active project session (drives the adapter, owns
 *    session and project-path state in a private closure)
 *  - read / write per-project compile + project.config.json settings
 *
 * IPC handlers, menu items and other callers must go through this service
 * rather than touching the repository or adapter directly.
 */
export interface WorkspaceService {
  // ── project list ────────────────────────────────────────────────────────
  listProjects(): Project[]
  addProject(dirPath: string): Project
  removeProject(dirPath: string): void
  validateProjectDir(dirPath: string): string | null

  // ── session lifecycle ───────────────────────────────────────────────────
  openProject(projectPath: string): Promise<OpenProjectResult>
  closeProject(): Promise<void>

  // ── session state (read-only) ──────────────────────────────────────────
  getSession(): { close: () => Promise<void>; port: number; appInfo: unknown } | null
  getProjectPath(): string
  hasActiveSession(): boolean

  // ── per-project data ────────────────────────────────────────────────────
  getProjectPages(projectPath: string): ProjectPages
  getCompileConfig(projectPath: string): CompileConfig
  saveCompileConfig(projectPath: string, config: CompileConfig): void
  getProjectSettings(projectPath: string): ProjectSettings
  updateProjectSettings(
    projectPath: string,
    patch: Partial<ProjectSettings>,
  ): void
}

/** Build a workspace service bound to the given workbench context. */
export function createWorkspaceService(ctx: WorkbenchContext): WorkspaceService {
  let currentSession: ProjectSession | null = null
  let currentProjectPath = ''

  function sendStatus(status: string, message: string): void {
    ctx.notify.projectStatus({ status, message })
  }

  function bestEffort(label: string, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      console.warn(`[workspace] ${label} failed (non-fatal):`, err)
    }
  }

  async function disposeSession(): Promise<void> {
    if (!currentSession) return
    const session = currentSession
    currentSession = null
    try {
      await Promise.race([
        session.close(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('session close timed out')), 5000),
        ),
      ])
    } catch (err) {
      console.error('[workspace] session close failed:', err)
    }
  }

  function applyRefererFromSession(session: ProjectSession): void {
    const appInfo = session.appInfo as { appId?: string; version?: string }
    if (appInfo && typeof appInfo.appId === 'string' && appInfo.appId.length > 0) {
      setSimulatorServicewechatReferer(
        appInfo.appId,
        typeof appInfo.version === 'string' ? appInfo.version : undefined,
      )
    }
  }

  return {
    listProjects: () => repo.listProjects(),
    addProject: (dirPath) => repo.addProject(dirPath),
    removeProject: (dirPath) => repo.removeProject(dirPath),
    validateProjectDir: (dirPath) => repo.validateProjectDir(dirPath),

    async openProject(projectPath) {
      clearSimulatorServicewechatReferer()
      await disposeSession()
      currentProjectPath = ''

      // Reject obviously broken projects up front so we never spin up a
      // compile/server that the simulator will then fetch asset-by-asset.
      // Without this guard, deleted recent-list entries and typo'd CLI paths
      // ride all the way through to the container runtime, whose
      // `fetch(…).then(r=>r.text()).then(JSON.parse)` pipeline dies on the
      // dev server's HTML SPA fallback with
      // `SyntaxError: Unexpected token '<', "<!doctype "…`.
      const dirError = repo.validateProjectDir(projectPath)
      if (dirError) {
        sendStatus('error', dirError)
        return { success: false, error: dirError }
      }

      sendStatus('compiling', '正在编译...')

      const { compile } = loadWorkbenchSettings()

      let session: Awaited<ReturnType<typeof ctx.adapter.openProject>>
      try {
        session = await ctx.adapter.openProject({
          projectPath,
          sourcemap: true,
          watch: compile.watch,
          onRebuild: () => sendStatus('ready', '编译完成，已热更新'),
          onBuildError: (err: unknown) => sendStatus('error', String(err)),
        })
      } catch (err) {
        clearSimulatorServicewechatReferer()
        sendStatus('error', String(err))
        return { success: false, error: String(err) }
      }

      currentSession = session
      currentProjectPath = projectPath

      bestEffort('updateLastOpened', () => repo.updateLastOpened(projectPath))
      bestEffort('sendStatus', () => sendStatus('ready', '编译完成'))
      bestEffort('applyReferer', () => applyRefererFromSession(session))

      return {
        success: true,
        port: session.port,
        appInfo: session.appInfo,
      }
    },

    async closeProject() {
      clearSimulatorServicewechatReferer()
      await disposeSession()
      currentProjectPath = ''
      ctx.views.disposeAll()
    },

    getSession: () => currentSession,
    getProjectPath: () => currentProjectPath,
    hasActiveSession: () => currentSession !== null,

    getProjectPages: (projectPath) => repo.getProjectPages(projectPath),
    getCompileConfig: (projectPath) => repo.getCompileConfig(projectPath),
    saveCompileConfig: (projectPath, config) =>
      repo.saveCompileConfig(projectPath, config),
    getProjectSettings: (projectPath) => repo.getProjectSettings(projectPath),
    updateProjectSettings: (projectPath, patch) =>
      repo.updateProjectSettings(projectPath, patch),
  }
}
