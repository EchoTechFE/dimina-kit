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
import { createOpLock } from './op-lock.js'
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
 * Runtime guard for the adapter-return boundary: `session.appInfo` must carry a
 * NON-EMPTY string `appId` (the renderer scopes IPC by it; the bridge's
 * handleSpawn also rejects empty appIds, so accepting `''` would desync layers).
 * Loose: extra fields pass through — only the contract-critical `appId` is enforced.
 */
const SessionAppInfoSchema = z.looseObject({ appId: z.string().min(1) })

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
  // so a remote provider (e.g. a downstream host's cloud workspace) works the same as the
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
  /**
   * True only while `closeProject` is tearing down. Bridge active-content
   * resolution consults this to avoid resolving the dying session's guest during
   * the close's session.close() await (when currentSession is already null but
   * the bridge app session still exists).
   */
  isClosing(): boolean

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
  // True only while closeProject tears down. disposeSession nulls currentSession
  // before awaiting session.close(), but the bridge app session lives until the
  // later disposeAll — bridge getters consult this to refuse resolving the dying
  // project's guest during that window.
  let closing = false
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

  // Serializes openProject/closeProject teardown/commit sections (FIFO) + latest-
  // wins request tokens, so a close mid-open can't disposeAll() the views the open
  // is building or desync currentSession vs the bridge appSessions. See op-lock.ts.
  const opLock = createOpLock()

  function sendStatus(status: string, message: string, hotReload?: boolean, pages?: string[], watcherDead?: boolean): void {
    ctx.notify.projectStatus({ status, message, ...(hotReload ? { hotReload: true } : {}), ...(pages ? { pages } : {}), ...(watcherDead ? { watcher: 'dead' as const } : {}) })
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

  /**
   * openProject critical section 1 — tear down the outgoing runtime under the op
   * lock (the unbounded compile runs after this releases, so a queued close isn't
   * blocked). Returns true when superseded (caller aborts without touching the
   * newer request's runtime).
   */
  async function runOpenTeardown(mySeq: number): Promise<boolean> {
    const release = await opLock.acquire()
    try {
      if (!opLock.isOwner(mySeq)) return true
      clearSimulatorServicewechatReferer()
      // Switching projects tears down the embedded workbench editor (mirrors one
      // project's disk; saves would else hit the wrong project) AND the native
      // simulator (its 'destroyed' hook owns the bridge session). Back-to-list
      // never calls closeProject, so this is the only deterministic teardown.
      if (currentSession !== null) {
        ctx.views.detachWorkbench()
        ctx.views.detachSimulator()
      }
      // Invalidate the outgoing onLog generation before teardown so the dying
      // worker's buffered lines can't pollute the incoming compile timeline.
      logGeneration++
      await disposeSession()
      currentProjectPath = ''
      lastClosedProjectPath = ''
      return false
    } finally {
      release()
    }
  }

  /**
   * openProject critical section 2 — commit the new session under the lock, only
   * if still the latest request. Returns false when superseded (caller discards
   * the freshly-opened session instead of clobbering the newer one).
   */
  async function runOpenCommit(
    mySeq: number,
    session: ProjectSession,
    projectPath: string,
  ): Promise<boolean> {
    const release = await opLock.acquire()
    try {
      if (!opLock.isOwner(mySeq)) return false
      currentSession = session
      currentProjectPath = projectPath
      return true
    } finally {
      release()
    }
  }

  /**
   * Drive the compile adapter for one open (OUTSIDE the op lock): returns the
   * session or an error message, never throws. The onLog generation guard drops
   * a superseded session's buffered lines.
   */
  async function runCompile(
    projectPath: string,
    sessionGeneration: number,
  ): Promise<{ session: ProjectSession } | { error: string }> {
    const { compile, preview } = loadWorkbenchSettings()
    try {
      const session = await ctx.adapter.openProject({
        projectPath,
        sourcemap: true,
        fileTypes: ctx.fileTypes,
        // Two independent gates: autoBuild = recompile on save; autoReload = refresh the simulator afterwards (off ⇒ page/form state survives; hotReload below stays false so the native simulator, which has no SSE reload, isn't refreshed).
        watch: compile.autoBuild,
        autoReload: preview.autoReload,
        onRebuild: (info) => {
          // getProjectPages never throws; empty pages (read failed / degenerate
          // project) are withheld so the renderer keeps its previous dropdown.
          const { pages } = repo.getProjectPages(projectPath)
          const pageList = pages.length ? pages : undefined
          // Style-only rebuild fast path: hot-swap the render-host stylesheets in
          // place instead of respawning the DeviceShell — the page stack / form
          // state / scroll / window focus all survive (no jitter, no focus
          // steal). `hotReload: false` keeps the renderer from bumping its reload
          // token (the respawn signal). Falls through to the full reload when the
          // swap can't run (no live render guest yet) so an edit is never dropped.
          if (info?.styleOnly && preview.autoReload && ctx.views.refreshSimulatorStyles()) {
            sendStatus('ready', '样式已热更新', false, pageList)
            return
          }
          sendStatus('ready', preview.autoReload ? '编译完成，已重启' : '编译完成', preview.autoReload, pageList)
        },
        onBuildError: (err: unknown) => sendStatus('error', String(err)),
        // Watcher died mid-session (EMFILE, permission loss, …): non-fatal, so 'ready' stays but `watcher: 'dead'` flags that saves no longer auto-rebuild.
        onWatcherError: () => sendStatus('ready', '文件监听已停止，保存不再触发自动编译', false, undefined, true),
        onLog: (entry: { stream: 'stdout' | 'stderr'; text: string }) => {
          if (sessionGeneration !== logGeneration) return
          ctx.notify.compileLog({ stream: entry.stream, text: entry.text, at: Date.now() })
        },
      })
      return { session }
    } catch (err) {
      clearSimulatorServicewechatReferer()
      return { error: String(err) }
    }
  }

  /**
   * Adapter-return boundary: a session without a string appId can't be driven by
   * the renderer, so it must never become active. Close the live resources the
   * adapter already spun up (best-effort) and return the error message; null when
   * valid.
   */
  async function rejectInvalidAppId(session: ProjectSession): Promise<string | null> {
    if (SessionAppInfoSchema.safeParse(session.appInfo).success) return null
    try {
      await session.close()
    } catch (closeErr) {
      console.warn('[workspace] closing appId-less adapter session failed (non-fatal):', closeErr)
    }
    return 'adapter returned session.appInfo without a string appId — '
      + 'the CompilationAdapter must supply appInfo.appId'
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
      // Claim a request seq before the veto hook's await so latest-wins is by
      // REQUEST order, not by which hook resolves first.
      const mySeq = opLock.nextSeq()
      // Host permission gate (WorkbenchAppConfig.onBeforeOpenProject): a throwing
      // hook vetoes the open and leaves the active session intact. Runs before
      // any side effect and outside the op lock/token.
      if (ctx.onBeforeOpenProject) {
        try {
          await ctx.onBeforeOpenProject(projectPath)
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          sendStatus('error', error)
          return { success: false, error }
        }
      }
      // Passed the veto — take ownership (a vetoed open never supersedes an
      // in-flight one; ownerSeq only grows, so a late-resolving earlier request
      // can't clobber a later one that already took over).
      opLock.takeOwnership(mySeq)
      if (await runOpenTeardown(mySeq)) {
        return { success: false, error: 'superseded by a newer project open/close' }
      }

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
      // This open owns the log channel until the next open/close bumps the
      // generation — runCompile's onLog closure checks it per line.
      const sessionGeneration = ++logGeneration
      const compiled = await runCompile(projectPath, sessionGeneration)
      if ('error' in compiled) {
        sendStatus('error', compiled.error)
        return { success: false, error: compiled.error }
      }
      const session = compiled.session

      const appIdError = await rejectInvalidAppId(session)
      if (appIdError) {
        sendStatus('error', appIdError)
        return { success: false, error: appIdError }
      }

      if (!(await runOpenCommit(mySeq, session, projectPath))) {
        // Superseded during the compile above — discard the freshly-opened
        // session (close its live compile/dev-server) rather than clobber the
        // newer request.
        try {
          await session.close()
        } catch (closeErr) {
          console.warn('[workspace] closing superseded open session failed (non-fatal):', closeErr)
        }
        return { success: false, error: 'superseded by a newer project open/close' }
      }

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
      // Claim a request seq and take ownership immediately (close has no veto),
      // then serialize against a concurrent openProject: disposeProjectViews()
      // must not run while an open is mid-teardown/commit (it would tear down
      // the views the open is building).
      const mySeq = opLock.nextSeq()
      opLock.takeOwnership(mySeq)
      const release = await opLock.acquire()
      try {
        // Superseded by a newer open/close that arrived while we waited for the
        // lock: that request now owns the runtime, so disposing here would tear
        // down ITS views. Skip — the newer op's own teardown covers the session
        // we meant to close.
        if (!opLock.isOwner(mySeq)) return
        // Mark the close in progress BEFORE disposeSession nulls currentSession,
        // so bridge getters refuse to resolve the dying session during the
        // session.close() await (cleared in the finally once views are gone).
        closing = true
        // Invalidate the active session's onLog BEFORE teardown starts — lines
        // flushed by the dying compile worker must not reach the panel.
        logGeneration++
        clearSimulatorServicewechatReferer()
        await disposeSession()
        // Record the root being torn down BEFORE clearing it, so a teardown/
        // debounced write already in flight can still be accepted against it.
        if (currentProjectPath !== '') lastClosedProjectPath = currentProjectPath
        currentProjectPath = ''
        // Project-scoped views only. The host toolbar is HOST-scoped and must
        // survive closing a project — its full teardown (disposeAll) runs from
        // the context registry at app teardown instead.
        ctx.views.disposeProjectViews()
      } finally {
        closing = false
        release()
      }
    },

    getSession: () => currentSession,
    getProjectPath: () => currentProjectPath,
    getLastClosedProjectPath: () => lastClosedProjectPath,
    hasActiveSession: () => currentSession !== null,
    isClosing: () => closing,

    async captureThumbnail(projectPath) {
      if (!currentSession || projectPath !== currentProjectPath) return null
      const simulatorWc = ctx.views.getSimulatorWebContents()
      if (!simulatorWc) return null
      if (ctx.views.getSimulatorProjectPath() !== projectPath) return null
      const session = currentSession
      // Capture the active render-host guest (the mini-program content); the
      // simulator WCV only holds the device-shell chrome. In native-host with no
      // active guest (not mounted / mid page-switch / destroyed) return null
      // rather than persist a device-shell frame as the page — that wrong-content
      // frame is the bug this path exists to avoid. Non-native-host: the sim WCV.
      const bridge = ctx.bridge
      const nativeHost = bridge?.isNativeHost() ?? false
      const renderGuest = nativeHost ? (bridge?.getActiveRenderWc() ?? null) : null
      if (nativeHost && !renderGuest) return null
      const captureTarget = renderGuest ?? simulatorWc
      // A destroyed target means teardown is in flight (no valid frame) — return
      // null rather than let capturePage() throw indistinguishably into the catch.
      if (captureTarget.isDestroyed()) return null
      try {
        const image = await captureTarget.capturePage()
        if (
          currentSession !== session
          || currentProjectPath !== projectPath
          || ctx.views.getSimulatorWebContents() !== simulatorWc
          || ctx.views.getSimulatorProjectPath() !== projectPath
          // Captured target must still be the live one: a guest that navigated
          // mid-capture would otherwise persist a frame from the wrong page.
          || (nativeHost ? (bridge?.getActiveRenderWc() ?? null) : simulatorWc) !== captureTarget
        ) {
          return null
        }
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
