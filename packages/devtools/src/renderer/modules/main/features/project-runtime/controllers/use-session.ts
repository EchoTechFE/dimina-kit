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
  openProject,
  saveCompileConfig,
} from '@/shared/api'
import type { AppInfo, CompileLogEntry } from '@/shared/api'
import type { CompileConfig } from '@/shared/types'
import { DEFAULT_SCENE } from '../../../../../../shared/constants'
import type { CompileStatus } from './use-project-runtime-controller'

export interface UseSessionProps {
  projectPath: string
}

/**
 * One entry of the 编译 tab's event log. Sourced EXCLUSIVELY from
 * `projectStatus` payloads — per-line dmcc output lands in `compileLogs`
 * instead; the two stores never cross (merging is a view concern).
 */
export interface CompileEvent {
  /** Wall-clock capture time (Date.now) of the payload's arrival. */
  at: number
  status: string
  message: string
  /** True when the payload came from a watcher rebuild (热更新 chip). */
  hotReload?: boolean
  /**
   * Optional shared monotonic arrival counter spanning compile events AND
   * compile logs — the panel's same-`at` tie-break (codex m8): `at` is a
   * millisecond stamp, so an event and the log lines of the same compile
   * routinely collide on it.
   */
  seq?: number
}

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
  // Shared monotonic arrival counter spanning BOTH stores (codex m8): `at`
  // is a millisecond stamp, so a status event and the log lines of the same
  // compile routinely collide on it — `seq` is the panel's same-`at`
  // tie-break carrier. A ref (not state): bumping it must not re-render, and
  // each arrival claims its seq OUTSIDE the functional updater so a
  // re-invoked updater (StrictMode) can't burn extra numbers.
  const compileSeqRef = useRef(0)

  // Each project gets an independent compile log: switching projects (the
  // projectPath-keyed openProject reset point) drops the previous project's
  // events AND lines. The initial mount runs this too (no-op on empty state).
  useEffect(() => {
    setCompileEvents([])
    setCompileLogs([])
  }, [projectPath])

  useEffect(() => {
    return onProjectStatus((data) => {
      setCompileStatus(data)
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
      // Resurrects the PR#12 hot-reload guard that PR#39 (workbench landing)
      // deleted together with the dead `<webview>` reload branch: a watcher
      // rebuild (hotReload:true) bumps the token so the simulator re-attaches.
      // Plain status chatter (compiling/error/ready) must NOT move the token.
      if (data.hotReload === true) {
        setHotReloadToken((token) => token + 1)
      }
    })
  }, [])

  useEffect(() => {
    return onCompileLog((entry) => {
      // `at` comes stamped from the main process — never re-stamped here.
      // `seq` IS stamped here: arrival order at the renderer is the only
      // order the merged panel timeline needs, and the counter is shared
      // with compileEvents above (codex m8).
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
  }
}
