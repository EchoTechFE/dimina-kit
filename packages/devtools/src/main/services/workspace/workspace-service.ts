import { webContents } from 'electron'
import type { CompileConfig, ProjectSession } from '../../../shared/types.js'
import type { WorkbenchContext } from '../workbench-context.js'
import * as repo from '../projects/project-repository.js'
import type {
  Project,
  ProjectPages,
  ProjectSettings,
} from '../projects/project-repository.js'
import type { ProjectsProvider } from '../projects/types.js'
import { DEFAULT_COMPILE_CONFIG } from '../projects/types.js'
import {
  clearSimulatorServicewechatReferer,
  setSimulatorServicewechatReferer,
} from '../simulator/referer.js'
import { loadWorkbenchSettings } from '../settings/index.js'
// Thumbnail FS helpers are now consumed via LocalProjectsProvider; the
// workspace-service only sees the ProjectsProvider hook surface.

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
  // Methods that flow through the host-injected ProjectsProvider are async,
  // so a remote provider (e.g. qdmp's cloud workspace) works the same as the
  // local FS-backed default. Callers must await.
  listProjects(): Promise<Project[]>
  addProject(dirPath: string): Promise<Project>
  removeProject(dirPath: string): Promise<void>
  hasProject(dirPath: string): Promise<boolean>
  validateProjectDir(dirPath: string): Promise<string | null>

  // ── session lifecycle ───────────────────────────────────────────────────
  openProject(projectPath: string): Promise<OpenProjectResult>
  closeProject(): Promise<void>

  // ── session state (read-only) ──────────────────────────────────────────
  getSession(): { close: () => Promise<void>; port: number; appInfo: unknown } | null
  getProjectPath(): string
  hasActiveSession(): boolean

  // ── thumbnails ──────────────────────────────────────────────────────────
  // Both methods flow through the host-injected ProjectsProvider too; a
  // remote host can store/serve screenshots from its own backend. Default
  // (LocalProjectsProvider) round-trips through `<userData>/thumbnails/`.
  captureThumbnail(projectPath: string): Promise<string | null>
  getThumbnail(projectPath: string): Promise<string | null>

  // ── per-project data ────────────────────────────────────────────────────
  getProjectPages(projectPath: string): ProjectPages
  getCompileConfig(projectPath: string): Promise<CompileConfig>
  saveCompileConfig(projectPath: string, config: CompileConfig): Promise<void>
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

  function sendStatus(status: string, message: string, hotReload?: boolean): void {
    ctx.notify.projectStatus(hotReload ? { status, message, hotReload: true } : { status, message })
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

  // Delegate to the host-injected (or default) ProjectsProvider on the
  // context. When the host omits an optional method, we apply a safe
  // documented default — never silently fall back to `repo.*`, because a
  // remote provider's project paths are not on the local filesystem.
  //
  // The `??` here is a back-compat path for hand-rolled WorkbenchContext
  // values (used in a couple of legacy tests). createWorkbenchContext
  // always installs LocalProjectsProvider, so production never enters this
  // branch.
  const provider: ProjectsProvider = ctx.projectsProvider ?? {
    listProjects: () => repo.listProjects(),
    addProject: (p) => repo.addProject(p),
    removeProject: (p) => repo.removeProject(p),
    validateProjectDir: (p) => repo.validateProjectDir(p),
    updateLastOpened: (p) => repo.updateLastOpened(p),
    getCompileConfig: (p) => repo.getCompileConfig(p),
    saveCompileConfig: (p, c) => repo.saveCompileConfig(p, c),
  }

  return {
    listProjects: async () => provider.listProjects(),
    addProject: async (dirPath) => provider.addProject(dirPath),
    removeProject: async (dirPath) => {
      await provider.removeProject(dirPath)
    },
    hasProject: async (dirPath) => {
      const projects = await provider.listProjects()
      return projects.some((p) => p.path === dirPath)
    },
    validateProjectDir: async (dirPath) =>
      provider.validateProjectDir
        ? provider.validateProjectDir(dirPath)
        : null,

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
      const dirError = provider.validateProjectDir
        ? await provider.validateProjectDir(projectPath)
        : null
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
          onRebuild: () => sendStatus('ready', '编译完成，已热更新', true),
          onBuildError: (err: unknown) => sendStatus('error', String(err)),
        })
      } catch (err) {
        clearSimulatorServicewechatReferer()
        sendStatus('error', String(err))
        return { success: false, error: String(err) }
      }

      currentSession = session
      currentProjectPath = projectPath

      bestEffort('updateLastOpened', () => {
        repo.updateLastOpened(projectPath)
        ctx.refreshMenu?.()
        if (provider.updateLastOpened) provider.updateLastOpened(projectPath)
      })
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

    async captureThumbnail(projectPath) {
      const simWcId = ctx.views.getSimulatorWebContentsId()
      if (!simWcId) return null
      const wc = webContents.fromId(simWcId)
      if (!wc || wc.isDestroyed()) return null
      try {
        const image = await wc.capturePage()
        const dataUrl = `data:image/png;base64,${image.toPNG().toString('base64')}`
        if (provider.saveThumbnail) {
          await provider.saveThumbnail(projectPath, dataUrl)
        }
        // Always hand the renderer back the freshly-captured frame so the
        // UI updates immediately even if the host's saveThumbnail is
        // async or stores out-of-band.
        return dataUrl
      } catch {
        return null
      }
    },

    async getThumbnail(projectPath) {
      if (provider.getThumbnail) {
        return (await provider.getThumbnail(projectPath)) ?? null
      }
      return null
    },

    // `getProjectPages` reads the project's own `app.json` from disk and is
    // independent of the project registry — it stays on the repo helper.
    getProjectPages: (projectPath) => repo.getProjectPages(projectPath),
    getCompileConfig: async (projectPath) =>
      (provider.getCompileConfig
        ? await provider.getCompileConfig(projectPath)
        : DEFAULT_COMPILE_CONFIG) as CompileConfig,
    saveCompileConfig: async (projectPath, config) => {
      if (provider.saveCompileConfig) {
        await provider.saveCompileConfig(projectPath, config)
      }
      // No persistence when the host opts out; the renderer's edits then
      // do not survive a reload, matching the documented contract.
    },
    // Per-project settings (uploadWithSourceMap etc.) live in the project's
    // own `project.config.json`, not the registry — keep direct repo calls.
    getProjectSettings: (projectPath) => repo.getProjectSettings(projectPath),
    updateProjectSettings: (projectPath, patch) =>
      repo.updateProjectSettings(projectPath, patch),
  }
}
