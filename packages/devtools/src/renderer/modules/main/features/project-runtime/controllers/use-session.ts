import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  getCompileConfig,
  getProjectPages,
  onCompileLog,
  onProjectStatus,
  onSessionRuntimeStatus,
  openProject,
  saveCompileConfig,
} from '@/shared/api'
import type { AppInfo, CompileLogEntry, SessionRuntimeStatusPayload } from '@/shared/api'
import type { CompileConfig } from '@/shared/types'
import type { CompileEvent } from '@dimina-kit/inspect'
import { DEFAULT_SCENE } from '../../../../../../shared/constants'
import type { CompileStatus } from './use-project-runtime-controller'

export interface UseSessionProps {
  projectPath: string
}

// The 编译 tab's event log entry shape lives in @dimina-kit/inspect (shared
// with CompilePanel); re-exported here so existing importers (the controller
// slice, tests) keep their `from '.../use-session'` path. Sourced EXCLUSIVELY
// from `projectStatus` payloads — per-line dmcc output lands in `compileLogs`
// instead; the two stores never cross (merging is a view concern).
export type { CompileEvent }

export type { CompileLogEntry }

/** compileEvents cap — FIFO, oldest evicted first. */
const MAX_COMPILE_EVENTS = 200
/** compileLogs cap — FIFO, oldest evicted first. */
const MAX_COMPILE_LOGS = 300

export interface SessionHookResult {
  compileStatus: CompileStatus
  appInfo: AppInfo | null
  port: number
  pages: string[]
  compileConfig: CompileConfig
  /**
   * Strictly-increasing counter, bumped once per `projectStatus` payload that
   * carries `hotReload: true` (a watcher rebuild finished). `use-simulator.ts`
   * folds it into its native attach-effect deps to respawn the DeviceShell.
   */
  hotReloadToken: number
  /**
   * Chronological (oldest-first) compile-event log: one entry per
   * `projectStatus` payload, capped at {@link MAX_COMPILE_EVENTS} FIFO.
   * Cleared by `clearCompileEvents` and on project switch.
   */
  compileEvents: CompileEvent[]
  /**
   * Chronological (oldest-first) per-line dmcc log fed by the
   * `project:compileLog` push, capped at {@link MAX_COMPILE_LOGS} FIFO.
   * Cleared together with `compileEvents`.
   */
  compileLogs: CompileLogEntry[]
  /** Empty BOTH compileEvents and compileLogs (the panel's single 清空). */
  clearCompileEvents: () => void
  relaunch: (nextConfig?: CompileConfig) => Promise<void>
  /**
   * Bumped on every explicit `relaunch` so the simulator attach effect forces a
   * fresh hard attach at `startPage` even when the URL is unchanged.
   */
  relaunchNonce: number
  /**
   * Latest runtime-lifecycle push for the active session (launching/running/
   * launch-failed/crashed, plus an optional start-page fallback). `null`
   * before the first push and again the moment a hot-reload rebuild starts a
   * fresh launch round — a stale terminal state (crashed/launch-failed) must
   * never survive into the next round's launch.
   */
  runtimeStatus: SessionRuntimeStatusPayload | null
  /** True once main reports the project's file watcher has died; persists for the rest of the session (cleared on project switch). */
  watcherDead: boolean
}

export function useSession(props: UseSessionProps): SessionHookResult {
  const { projectPath } = props

  const [compileStatus, setCompileStatus] = useState<CompileStatus>({
    status: 'compiling',
    message: '正在编译...',
  })
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [pages, setPages] = useState<string[]>([])
  const [port, setPort] = useState(0)
  const [compileConfig, setCompileConfig] = useState<CompileConfig>({
    startPage: '',
    scene: DEFAULT_SCENE,
    queryParams: [],
  })
  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const result = await openProject(projectPath)
        if (cancelled) return

        if (!result.success) {
          setCompileStatus({ status: 'error', message: result.error })
          return
        }

        // Fetch pages + compile config BEFORE committing port/appInfo to state,
        // so the first <webview> render already has the correct startPage. If
        // port is set first, simulatorUrl renders with an empty startPage and
        // falls back to the hardcoded 'pages/index/index', triggering a wasted
        // load for a page that doesn't exist in the compiled output.
        const [pagesResult, config] = await Promise.all([
          getProjectPages(projectPath),
          getCompileConfig(projectPath),
        ])
        if (cancelled) return

        setAppInfo(result.appInfo)
        setPort(result.port)
        setPages(pagesResult.pages)
        setCompileConfig({
          startPage:
            config.startPage ||
            pagesResult.entryPagePath ||
            pagesResult.pages[0] ||
            '',
          scene: config.scene ?? DEFAULT_SCENE,
          queryParams: config.queryParams || [],
        })
        setCompileStatus({ status: 'ready', message: '编译完成' })
      } catch (err) {
        if (cancelled) return
        setCompileStatus({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [projectPath])

  const [hotReloadToken, setHotReloadToken] = useState(0)
  const [compileEvents, setCompileEvents] = useState<CompileEvent[]>([])
  const [compileLogs, setCompileLogs] = useState<CompileLogEntry[]>([])
  // Shared monotonic arrival counter spanning BOTH stores: `at`
  // is a millisecond stamp, so a status event and the log lines of the same
  // compile routinely collide on it — `seq` is the panel's same-`at`
  // tie-break carrier. A ref (not state): bumping it must not re-render, and
  // each arrival claims its seq OUTSIDE the functional updater so a
  // re-invoked updater (StrictMode) can't burn extra numbers.
  const compileSeqRef = useRef(0)

  const [runtimeStatus, setRuntimeStatus] = useState<SessionRuntimeStatusPayload | null>(null)
  const [watcherDead, setWatcherDead] = useState(false)

  // Each project gets an independent compile log: switching projects (the
  // projectPath-keyed openProject reset point) drops the previous project's
  // events AND lines, and clears runtime state carried over from the old
  // session.
  useEffect(() => {
    setCompileEvents([])
    setCompileLogs([])
    setRuntimeStatus(null)
    setWatcherDead(false)
  }, [projectPath])

  useEffect(() => {
    return onProjectStatus((data) => {
      setCompileStatus(data)
      // Refresh the launch-page dropdown from a hot-reload rebuild's page list
      // when the main process could read one; a failed read omits `pages` so
      // the previous list is left in place instead of being blanked.
      if (data.pages) {
        setPages(data.pages)
      }
      // A live watcher-death report is a session-lifetime fact — sticky until
      // the next project open, not cleared by later projectStatus chatter.
      if (data.watcher === 'dead') {
        setWatcherDead(true)
      }
      // 编译 tab event log: one entry per projectStatus payload (this
      // subscription is its ONLY source — the initial local load above sets
      // compileStatus without synthesizing an event). Functional update:
      // bursts of payloads in one tick must each see the previous append.
      const seq = ++compileSeqRef.current
      setCompileEvents((prev) => {
        const event: CompileEvent = data.hotReload === true
          ? { at: Date.now(), status: data.status, message: data.message, hotReload: true, seq }
          : { at: Date.now(), status: data.status, message: data.message, seq }
        const next = [...prev, event]
        return next.length > MAX_COMPILE_EVENTS
          ? next.slice(next.length - MAX_COMPILE_EVENTS)
          : next
      })
      // Hot-reload guard: a watcher rebuild (hotReload:true) bumps the token
      // so the simulator re-attaches, AND a fresh launch round is about to
      // start — drop any terminal runtimeStatus (crashed/launch-failed) from
      // the PREVIOUS round so it can't outlive the recompile.
      // Plain status chatter (compiling/error/ready) must NOT move the token.
      if (data.hotReload === true) {
        setRuntimeStatus(null)
        setHotReloadToken((token) => token + 1)
      }
    })
  }, [])

  // Runtime-lifecycle push (launching/running/launch-failed/crashed, plus an
  // optional start-page fallback) — a separate channel from projectStatus
  // because it reports on the SPAWNED app session, not the compiler. The
  // channel is a global broadcast, so a late event from a previous project's
  // dying session (e.g. its crash landing mid-switch) must not paint this
  // project's panel — accept only payloads for the app currently shown.
  useEffect(() => {
    return onSessionRuntimeStatus((payload) => {
      if (appInfo?.appId && payload.appId !== appInfo.appId) return
      setRuntimeStatus(payload)
    })
  }, [appInfo])

  useEffect(() => {
    return onCompileLog((entry) => {
      // `at` comes stamped from the main process — never re-stamped here.
      // `seq` IS stamped here: arrival order at the renderer is the only
      // order the merged panel timeline needs, and the counter is shared
      // with compileEvents above.
      const seq = ++compileSeqRef.current
      setCompileLogs((prev) => {
        const next = [...prev, { ...entry, seq }]
        return next.length > MAX_COMPILE_LOGS
          ? next.slice(next.length - MAX_COMPILE_LOGS)
          : next
      })
    })
  }, [])

  // One 清空 action, both stores: the panel renders events and logs as a
  // single merged timeline, so clearing one without the other would leave
  // a half-empty view.
  const clearCompileEvents = useCallback(() => {
    setCompileEvents([])
    setCompileLogs([])
  }, [])

  const isRefreshing = useRef(false)
  // Bumped by every explicit relaunch (重新编译 / error-overlay retry). The
  // native attach effect keys re-attaches on `simulatorUrl` OR this nonce, so an
  // explicit relaunch forces a fresh hard attach at `startPage` EVEN when the
  // resulting URL is byte-identical. Without it, relaunching to a `startPage`
  // that equals the current config's `startPage` yields an unchanged
  // `simulatorUrl`, the effect never re-runs, and the simulator stays on
  // whatever page it drifted to (in-app nav / hot reload) instead of resetting.
  const [relaunchNonce, setRelaunchNonce] = useState(0)

  const relaunch = useCallback(
    async (nextConfig: CompileConfig = compileConfig) => {
      try {
        if (!appInfo?.appId || isRefreshing.current) return

        // Under native-host the simulator is a main-process WebContentsView, so
        // there is no renderer `<webview>` to `loadURL`. Re-publishing the
        // compile config changes `simulatorUrl`, and `use-simulator.ts`'s native
        // attach effect re-runs `attachNativeSimulator(newUrl)`, which tears down
        // the old DeviceShell and respawns it at the new start page.
        isRefreshing.current = true
        setCompileStatus({ status: 'ready', message: '正在刷新...' })
        try {
          await saveCompileConfig(projectPath, nextConfig)
          // Triggers the native re-attach effect (simulatorUrl depends on this).
          setCompileConfig(nextConfig)
          // Force the re-attach even when nextConfig leaves simulatorUrl
          // unchanged — an explicit relaunch always resets to startPage.
          setRelaunchNonce((n) => n + 1)
          setCompileStatus({ status: 'ready', message: '刷新完成' })
        } finally {
          isRefreshing.current = false
        }
      } catch (error) {
        isRefreshing.current = false
        setCompileStatus({
          status: 'error',
          message: error instanceof Error ? error.message : '刷新失败',
        })
      }
    },
    [appInfo, compileConfig, projectPath],
  )

  return {
    compileStatus,
    appInfo,
    port,
    pages,
    compileConfig,
    hotReloadToken,
    compileEvents,
    compileLogs,
    clearCompileEvents,
    relaunch,
    relaunchNonce,
    runtimeStatus,
    watcherDead,
  }
}
