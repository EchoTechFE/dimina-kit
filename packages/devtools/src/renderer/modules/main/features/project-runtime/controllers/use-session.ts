import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  getCompileModeState,
  getProjectPages,
  onCompileLog,
  onCompileModesApplyFailed,
  onCompileModesChanged,
  onProjectStatus,
  onSessionRuntimeStatus,
  openProject,
  rebuildProject,
} from '@/shared/api'
import type { AppInfo, CompileLogEntry, SessionRuntimeStatusPayload } from '@/shared/api'
import type { CompileConfig, CompileModeState } from '@/shared/types'
import type { CompileEvent } from '@dimina-kit/inspect'
import { compileConfigFromMode } from '../../../../../../shared/compile-modes'
import { emptyCompileModeState, selectedMode } from '../../../../../../shared/compile-mode-state'
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
  /** The page 普通编译 launches — the project's own entry page. */
  entryPagePath: string
  /**
   * The project's named compile modes and which one is selected — mirrors
   * the main-process `CompileModeStore`, updated by `getCompileModeState` on
   * open and by `onCompileModesChanged` pushes thereafter. Editing goes
   * through `applyPopoverCommand`, straight to main; this hook only adopts
   * the result.
   */
  compileModes: CompileModeState
  /**
   * True once main has opened this window's project into a `CompileModeStore`
   * AND the local mirror has adopted at least one snapshot/push from it.
   * Before that, `getCompileModeState`/`applyCompileModeCommand` on main
   * throw `no compile-mode store open` — the popover's Show has nothing
   * authoritative to read, so gate it on this instead.
   */
  compileModesReady: boolean
  /**
   * The launch parameters the selected mode resolves to, with 普通编译's empty
   * start page filled in from the project's entry page. Derived from
   * `compileModes` — never edited directly.
   */
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
  relaunch: () => Promise<void>
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
  const [entryPagePath, setEntryPagePath] = useState('')
  const [compileModes, setCompileModes] = useState<CompileModeState>(emptyCompileModeState())
  const [compileModesReady, setCompileModesReady] = useState(false)

  // The single derived view of the selected mode. 普通编译 resolves to an empty
  // start page — only this layer knows the project's own entry page, so the
  // substitution happens here rather than in the pure resolver.
  const compileConfig = useMemo<CompileConfig>(() => {
    const resolved = compileConfigFromMode(selectedMode(compileModes))
    return {
      ...resolved,
      startPage: resolved.startPage || entryPagePath || pages[0] || '',
    }
  }, [compileModes, entryPagePath, pages])

  // The highest `CompileModeStore` revision adopted so far for the CURRENT
  // project — reset per `projectPath`. Guards against a slow `getCompileModeState`
  // fetch resolving AFTER a fresher `onCompileModesChanged` push already
  // landed: whichever side carries the higher revision wins, regardless of
  // arrival order, so the in-flight fetch can never roll a newer push back.
  const revisionRef = useRef(-1)
  // Mirrors `relaunch` so the change-adoption effect below (subscribed once
  // per `projectPath`) can always call the LATEST relaunch without itself
  // depending on `relaunch` — depending on it would tear the subscription
  // down and rebuild it on every relaunch-callback identity change.
  const relaunchRef = useRef<() => Promise<void>>(async () => {})

  useEffect(() => {
    let cancelled = false
    revisionRef.current = -1
    setCompileModesReady(false)

    // Registered synchronously, before any async work starts, so a push that
    // lands while `load()` is still in flight can never be missed.
    const offChanged = onCompileModesChanged((change) => {
      if (cancelled) return
      if (change.revision <= revisionRef.current) return
      revisionRef.current = change.revision
      setCompileModes(change.state)
      setCompileModesReady(true)
      if (change.relaunch) void relaunchRef.current()
    })
    const offApplyFailed = onCompileModesApplyFailed((payload) => {
      if (cancelled) return
      setCompileStatus({ status: 'error', message: payload.message })
    })

    async function load() {
      try {
        const result = await openProject(projectPath)
        if (cancelled) return

        if (!result.success) {
          setCompileStatus({ status: 'error', message: result.error })
          return
        }

        // Fetch pages + compile-mode state BEFORE committing port/appInfo to
        // state, so the first <webview> render already has the correct
        // startPage. If port is set first, simulatorUrl renders with an
        // empty startPage and falls back to the hardcoded
        // 'pages/index/index', triggering a wasted load for a page that
        // doesn't exist in the compiled output.
        const [pagesResult, snapshot] = await Promise.all([
          getProjectPages(projectPath),
          getCompileModeState(projectPath),
        ])
        if (cancelled) return

        setAppInfo(result.appInfo)
        setPort(result.port)
        setPages(pagesResult.pages)
        setEntryPagePath(pagesResult.entryPagePath || pagesResult.pages[0] || '')
        // A push carrying a higher revision may have already arrived while
        // this fetch was in flight — discard the now-stale fetch result
        // rather than rolling the adopted state backward.
        if (snapshot.revision > revisionRef.current) {
          revisionRef.current = snapshot.revision
          setCompileModes(snapshot.state)
          setCompileModesReady(true)
        }
        setCompileStatus({ status: 'ready', message: '编译完成' })
      } catch (err) {
        if (cancelled) return
        setCompileStatus({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    }

    void load()
    return () => {
      cancelled = true
      offChanged()
      offApplyFailed()
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
    async () => {
      try {
        if (!appInfo?.appId || isRefreshing.current) return

        // Under native-host the simulator is a main-process WebContentsView, so
        // there is no renderer `<webview>` to `loadURL`. Re-publishing the
        // compile config changes `simulatorUrl`, and `use-simulator.ts`'s native
        // attach effect re-runs `attachNativeSimulator(newUrl)`, which tears down
        // the old DeviceShell and respawns it at the new start page.
        isRefreshing.current = true
        // Keep the simulator attach effect gated until rebuildProject resolves.
        // In particular, an error-overlay retry starts from `error`; switching
        // to `ready` here would immediately hard-attach stale/partial output
        // before the rebuild has had a chance to succeed.
        setCompileStatus({ status: 'compiling', message: '正在编译...' })
        try {
          // 重新编译 means a REAL recompile first (WeChat devtools semantics):
          // with autoBuild off or a dead watcher this is the only way edits
          // reach the build. The hard re-attach below must reflect a build
          // that actually ran, so it strictly follows this await. A rejection
          // (build failure) skips the re-attach entirely — the simulator
          // keeps its current, still-working session. `{ supported: false }`
          // (host adapter without a real rebuild) falls through to the
          // reattach-only behavior.
          await rebuildProject()
          // Force the re-attach even when the compile config leaves
          // simulatorUrl unchanged — an explicit relaunch always resets to
          // startPage.
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
    [appInfo],
  )

  useEffect(() => {
    relaunchRef.current = relaunch
  }, [relaunch])

  return {
    compileStatus,
    appInfo,
    port,
    pages,
    entryPagePath,
    compileModes,
    compileModesReady,
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
