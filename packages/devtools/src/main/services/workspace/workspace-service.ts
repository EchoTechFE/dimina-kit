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
 * object carrying a NON-EMPTY string `appId` (the renderer derives its IPC
 * scoping from it; a session without one cannot be driven, and the bridge's
 * handleSpawn rejects empty appIds too — so accepting `''` here would desync the
 * two layers). Loose: extra fields pass through untouched — only the
 * contract-critical `appId` is enforced.
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

  // Serializes the teardown→commit sections of openProject/closeProject so they
  // never interleave. Without it, a closeProject arriving while an openProject
  // is awaiting the compile adapter runs disposeAll() and tears down the very
  // views the open is building, and the two state stores (this closure's
  // currentSession and the bridge's appSessions) desync. FIFO is sufficient:
  // close is bounded by disposeSession()'s 5s timeout, so a queued op waits at
  // most that long. The chain never rejects (each op releases in a finally).
  let opLock: Promise<void> = Promise.resolve()
  // Latest-wins half that the FIFO lock alone can't provide. `requestSeq` is a
  // monotonic counter claimed at the START of every open/close (before any
  // await), so it encodes REQUEST order — not hook/compile completion order.
  // `ownerSeq` is the highest seq that has actually taken ownership of the
  // runtime: an open promotes itself into it only AFTER passing its veto hook
  // (so a vetoed open never supersedes an in-flight one), close promotes at
  // entry. A critical section aborts when `mySeq !== ownerSeq` — it released the
  // lock for the unbounded compile and a later request took over meanwhile.
  let requestSeq = 0
  let ownerSeq = 0
  function takeOwnership(mySeq: number): void {
    if (mySeq > ownerSeq) ownerSeq = mySeq
  }
  function acquireOpLock(): Promise<() => void> {
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    const prior = opLock
    opLock = prior.then(() => next)
    return prior.then(() => release)
  }

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
      // Claim a request seq FIRST (before the veto hook's await) so latest-wins
      // is decided by REQUEST order, not by which hook resolves first. Two
      // concurrent opens whose hooks finish out of order must still let the
      // later-requested one win.
      const mySeq = ++requestSeq
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
      // Passed the veto — NOW take ownership (promote our seq). Doing this after
      // the hook means a vetoed open never supersedes an in-flight one. ownerSeq
      // only grows, so an earlier request whose hook resolved late can't clobber
      // a later request that already took over.
      takeOwnership(mySeq)
      // Critical section 1 — tear down the outgoing runtime. Serialized against a
      // concurrent close so the two never interleave. The unbounded adapter
      // compile runs AFTER this section releases the lock, so a queued close is
      // never blocked behind a slow/hung compile.
      const releaseTeardown = await acquireOpLock()
      try {
      // Superseded while waiting for the lock (a newer open/close already took
      // over): skip teardown so we don't tear down the newer request's runtime.
      if (mySeq !== ownerSeq) {
        return { success: false, error: 'superseded by a newer project open/close' }
      }
      clearSimulatorServicewechatReferer()
      // Switching from one project to another must tear down the embedded
      // workbench editor view. The workbench mirrors a single project's disk
      // to `file:///workspace` ONCE at boot and routes `/__fs` writes at the
      // live active project root; if the WCV survives a switch, the editor
      // keeps showing project A's mirrored tree while saves land in project B
      // (wrong project). Detaching destroys the WCV so the next time the
      // 'editor' slot becomes visible it lazily re-attaches and re-mirrors the
      // new project (setWorkbenchBounds re-creates from the stored source on
      // the first non-zero rect). Guarded on an active session so the first
      // open (no predecessor) is a safe no-op.
      if (currentSession !== null) {
        ctx.views.detachWorkbench()
        // Symmetric with detachWorkbench: switching projects must also tear
        // down the previous project's native simulator WCV, and through its
        // `destroyed` hook the bridge app session that WCV owns. Returning to
        // the project list never calls closeProject (the back button only
        // notifies windowNavigateBack), so without this the old session
        // survives into the open: its WCV keeps painting the previous app,
        // `resolveCurrentApp` can still resolve the stale same-appId session,
        // and the shared `persist:miniapp-<appId>` partition lets the reopened
        // project reuse the old guest — so the simulator renders the PREVIOUS
        // project. Tearing it down here lets the renderer's subsequent
        // attachNativeSimulator build a clean view for the incoming project.
        ctx.views.detachSimulator()
      }
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
      } finally {
        releaseTeardown()
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

      // Critical section 2 — commit the new session, but only if we are still
      // the latest request. A newer open/close that arrived during the unbounded
      // compile above bumped opGeneration; committing now would clobber it, so
      // discard the freshly-opened session (close its live compile/dev-server)
      // and report superseded.
      const releaseCommit = await acquireOpLock()
      try {
        if (mySeq !== ownerSeq) {
          try {
            await session.close()
          } catch (closeErr) {
            console.warn('[workspace] closing superseded open session failed (non-fatal):', closeErr)
          }
          return { success: false, error: 'superseded by a newer project open/close' }
        }
        currentSession = session
        currentProjectPath = projectPath
      } finally {
        releaseCommit()
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
      // then serialize against a concurrent openProject: disposeAll() must not
      // run while an open is mid-teardown/commit (it would tear down the views
      // the open is building).
      const mySeq = ++requestSeq
      takeOwnership(mySeq)
      const release = await acquireOpLock()
      try {
        // Superseded by a newer open/close that arrived while we waited for the
        // lock: that request now owns the runtime, so disposing here would tear
        // down ITS views. Skip — the newer op's own teardown covers the session
        // we meant to close.
        if (mySeq !== ownerSeq) return
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
      } finally {
        release()
      }
    },

    getSession: () => currentSession,
    getProjectPath: () => currentProjectPath,
    getLastClosedProjectPath: () => lastClosedProjectPath,
    hasActiveSession: () => currentSession !== null,

    async captureThumbnail(projectPath) {
      if (!currentSession || projectPath !== currentProjectPath) return null
      const simulatorWc = ctx.views.getSimulatorWebContents()
      if (!simulatorWc) return null
      if (ctx.views.getSimulatorProjectPath() !== projectPath) return null
      const session = currentSession
      // In native-host the active render-host guest holds the mini-program
      // content; the simulator WCV only holds the device-shell chrome. Capture
      // the guest. When native-host reports no active guest (not mounted yet,
      // mid page-switch, or destroyed) there is no page content to snapshot, so
      // return null rather than persist a device-shell frame as if it were the
      // page — that device-shell frame is exactly the wrong-content bug this
      // capture path exists to avoid. Non-native-host has no guest concept, so
      // the simulator WCV is the correct target there.
      const bridge = ctx.bridge
      const nativeHost = bridge?.isNativeHost() ?? false
      const renderGuest = nativeHost ? (bridge?.getActiveRenderWc() ?? null) : null
      if (nativeHost && !renderGuest) return null
      const captureTarget = renderGuest ?? simulatorWc
      // Distinguish "no content to capture" from a lifecycle error: a destroyed
      // target means the guest/WCV is gone (teardown in flight), so there is no
      // valid frame — return null instead of letting capturePage() throw into
      // the catch (which can't tell the two apart).
      if (captureTarget.isDestroyed()) return null
      try {
        const image = await captureTarget.capturePage()
        if (
          currentSession !== session
          || currentProjectPath !== projectPath
          || ctx.views.getSimulatorWebContents() !== simulatorWc
          || ctx.views.getSimulatorProjectPath() !== projectPath
          // The captured WebContents must still be the live capture target:
          // a render guest that navigated mid-capture would otherwise persist a
          // frame from the wrong page (the previous staleness anchor only
          // tracked the outer WCV, not the guest we actually captured).
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
