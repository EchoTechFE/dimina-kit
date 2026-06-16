import { z } from 'zod'
import type { AppInfo, CompileConfig, ProjectSession } from '../../../shared/types.js'
// eslint-disable-next-line no-restricted-syntax -- grandfathered(workbench-context): shrink-only
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
  appInfo?: AppInfo
  error?: string
}

/**
 * Runtime guard for the adapter-return boundary: `session.appInfo` must be an
 * object carrying a string `appId` (the renderer derives its IPC scoping from
 * it; a session without one cannot be driven). Loose: extra fields pass
 * through untouched — only the contract-critical `appId` is enforced.
 */
const SessionAppInfoSchema = z.looseObject({ appId: z.string() })

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
  getSession(): ProjectSession | null
  getProjectPath(): string
  /**
   * The project path most recently torn down by `closeProject`, or '' if none
   * since the last `openProject`. Lets the project-fs sandbox accept an
   * in-flight write (debounced/teardown flush) that targets the just-closed
   * project even though `getProjectPath()` has already been cleared. Reset to
   * '' on the next `openProject` so it never accumulates stale roots.
   */
  getLastClosedProjectPath(): string
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
  // The last project path cleared by `closeProject`; consumed by project-fs to
  // accept an in-flight write that targets the just-closed project. Reset at
  // the start of every `openProject` so it never accumulates a stale root.
  let lastClosedProjectPath = ''
  // Session generation for the onLog closure handed to the adapter: a closed
  // (or switched-away-from) session's compile worker dies asynchronously, so
  // buffered log lines can still arrive through the OLD closure after
  // closeProject/openProject. Each openProject claims a new generation and
  // closeProject invalidates the current one; a stale closure sees the
  // mismatch and drops the line instead of polluting the next project's
  // compile panel. (Deliberately NOT a `currentSession !== null` check: the
  // first compile's log lines arrive while the adapter promise is still
  // pending, before currentSession is assigned.)
  let logGeneration = 0

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

  // Delegate to the host-injected (or default LocalProjectsProvider)
  // ProjectsProvider on the context. When the host omits an optional method,
  // we apply a safe documented default — never silently fall back to
  // `repo.*`, because a remote provider's project paths are not on the local
  // filesystem.
  const provider: ProjectsProvider = ctx.projectsProvider

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
      // Host permission gate — runs BEFORE any side effect (referer reset,
      // session teardown, compile/dev-server spin-up). A throwing hook vetoes
      // the open: return early with the error and leave the currently-active
      // session fully intact. The declarative replacement for monkey-patching
      // this method. See WorkbenchAppConfig.onBeforeOpenProject.
      if (ctx.onBeforeOpenProject) {
        try {
          await ctx.onBeforeOpenProject(projectPath)
        } catch (err) {
          // Surface the veto to the status bar — symmetric with the
          // validateProjectDir rejection below (which already emits an error
          // status). The framework caught the error, so it owns the minimal
          // user-visible feedback; a host gate must not have to thread
          // `notify` through a singleton just to report why the open was
          // denied. The host can still layer richer UX (e.g. a dialog).
          const error = err instanceof Error ? err.message : String(err)
          sendStatus('error', error)
          return { success: false, error }
        }
      }
      clearSimulatorServicewechatReferer()
      // Invalidate the outgoing session's onLog BEFORE teardown starts (same
      // order as closeProject below): the dying compile worker flushes
      // buffered lines DURING disposeSession(), and with the old generation
      // still current they would pass the staleness guard and pollute the
      // incoming project's compile-log timeline. The new session claims its
      // own fresh generation further down (after dispose), so its onLog
      // forwards normally.
      logGeneration++
      await disposeSession()
      currentProjectPath = ''
      // A fresh open starts a clean sandbox window — drop any previously
      // recorded last-closed root so it can't accept writes after this point.
      lastClosedProjectPath = ''

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

      // This open owns the log channel until the next open/close bumps the
      // generation — the onLog closure below checks it per line.
      const sessionGeneration = ++logGeneration

      let session: Awaited<ReturnType<typeof ctx.adapter.openProject>>
      try {
        session = await ctx.adapter.openProject({
          projectPath,
          sourcemap: true,
          watch: compile.watch,
          onRebuild: () => sendStatus('ready', '编译完成，已热更新', true),
          onBuildError: (err: unknown) => sendStatus('error', String(err)),
          // Per-line dmcc log (already filtered in devkit). Stamp the
          // wall-clock capture time here and push verbatim on the dedicated
          // compile-log channel — never through projectStatus, whose
          // one-event-per-payload contract feeds compileEvents. Stale lines
          // (a closed/replaced session's worker flushing its buffers) are
          // dropped via the generation check.
          onLog: (entry: { stream: 'stdout' | 'stderr'; text: string }) => {
            if (sessionGeneration !== logGeneration) return
            ctx.notify.compileLog({
              stream: entry.stream,
              text: entry.text,
              at: Date.now(),
            })
          },
        })
      } catch (err) {
        clearSimulatorServicewechatReferer()
        sendStatus('error', String(err))
        return { success: false, error: String(err) }
      }

      // Adapter-return boundary: enforce the AppInfo producer contract the
      // moment the adapter resolves, BEFORE the session is recorded. A
      // session without a string appId cannot be driven by the renderer, so
      // it must never become the active session. The adapter already spun up
      // live resources (compile watcher, dev-server port) — close them
      // best-effort before reporting; the validation report is the law and a
      // failing close() must not mask it (or escape as a throw).
      if (!SessionAppInfoSchema.safeParse(session.appInfo).success) {
        try {
          await session.close()
        } catch (closeErr) {
          console.warn(
            '[workspace] closing appId-less adapter session failed (non-fatal):',
            closeErr,
          )
        }
        const error =
          'adapter returned session.appInfo without a string appId — ' +
          'the CompilationAdapter must supply appInfo.appId'
        sendStatus('error', error)
        return { success: false, error }
      }

      currentSession = session
      currentProjectPath = projectPath

      bestEffort('updateLastOpened', () => {
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
      // Invalidate the active session's onLog BEFORE teardown starts — lines
      // flushed by the dying compile worker must not reach the panel.
      logGeneration++
      clearSimulatorServicewechatReferer()
      await disposeSession()
      // Record the root being torn down BEFORE clearing it, so a teardown/
      // debounced write already in flight can still be accepted against it.
      if (currentProjectPath !== '') lastClosedProjectPath = currentProjectPath
      currentProjectPath = ''
      ctx.views.disposeAll()
    },

    getSession: () => currentSession,
    getProjectPath: () => currentProjectPath,
    getLastClosedProjectPath: () => lastClosedProjectPath,
    hasActiveSession: () => currentSession !== null,

    async captureThumbnail(projectPath) {
      const wc = ctx.views.getSimulatorWebContents()
      if (!wc) return null
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
