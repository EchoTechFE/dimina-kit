import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { RefObject } from 'react'
import {
  attachNativeSimulator,
  captureThumbnail,
  onSimulatorCurrentPage,
  softReloadNativeSimulator,
} from '@/shared/api'
import type { AppInfo } from '@/shared/api'
import {
  buildSimulatorUrl,
  getCurrentPagePath,
} from '../../../../../../shared/simulator-route'
import type { CompileConfig } from '@/shared/types'
import type { CompileStatus, DeviceType } from './use-project-runtime-controller'

export interface UseSimulatorProps {
  compileStatus: CompileStatus
  sendDeviceInfo: (device: DeviceType) => void
  simPanelWidthRef: RefObject<number>
  deviceRef: RefObject<DeviceType>
  appInfo: AppInfo | null
  compileConfig: CompileConfig
  port: number
  projectPath: string
  /**
   * Hot-reload signal from `useSession`: bumped once per watcher rebuild
   * (`projectStatus` with `hotReload: true`). Each bump respawns the
   * DeviceShell exactly once via `attachNativeSimulator`.
   */
  hotReloadToken: number
}

export interface SimulatorHookResult {
  simulatorUrl: string
  currentPage: string
}

export function useSimulator(props: UseSimulatorProps): SimulatorHookResult {
  const {
    compileStatus,
    sendDeviceInfo,
    simPanelWidthRef,
    deviceRef,
    appInfo,
    compileConfig,
    port,
    projectPath,
    hotReloadToken,
  } = props

  const simulatorUrl = useMemo(() => {
    if (!appInfo || !port) return ''
    return buildSimulatorUrl(appInfo.appId, compileConfig, port)
  }, [appInfo, compileConfig, port])

  const [currentPage, setCurrentPage] = useState(() =>
    getCurrentPagePath(simulatorUrl),
  )

  useEffect(() => {
    setCurrentPage(getCurrentPagePath(simulatorUrl))
  }, [simulatorUrl])

  // The page stack lives in the DeviceShell WebContentsView, so in-app
  // navigation never reaches a renderer `<webview>`'s did-navigate events.
  // Subscribe to main's active-page push so the toolbar route stays in sync.
  // Empty path = unknown → keep the URL-seeded value.
  useEffect(() => {
    return onSimulatorCurrentPage((pagePath) => {
      if (pagePath) setCurrentPage(pagePath)
    })
  }, [])

  // Latest-value mirror for the hot-reload path. The attach effect must NOT
  // depend on `currentPage`/`compileConfig`/`appInfo`/`port` directly (in-app
  // navigation or config identity churn would re-attach the simulator), so it
  // reads them through this render-synced ref instead. The sync effect has no
  // dep array (runs every render) and is declared BEFORE the attach effect so
  // the context is always fresh when the attach effect reads it.
  const hotReloadContextRef = useRef({ currentPage, compileConfig, appInfo, port })
  useEffect(() => {
    hotReloadContextRef.current = { currentPage, compileConfig, appInfo, port }
  })

  // Last token the attach effect has consumed. Seeded with the initial token
  // so the mount attach is a plain attach, not a hot reload.
  const attachedHotReloadTokenRef = useRef(hotReloadToken)

  // ── Mount the simulator as a main-process WebContentsView ───────────────────
  // We ask main to create + load the WCV with the simulatorUrl; main's preload
  // then drives SPAWN → DeviceShell. `currentPage` mirrors the URL (page-stack
  // nav happens inside the WCV and arrives via onSimulatorCurrentPage above).
  //
  // `hotReloadToken` resurrects the hot-reload guard a later refactor deleted:
  // a watcher rebuild bumps the token, the effect re-runs exactly once, and
  // `attachNativeSimulator` tears down + respawns the DeviceShell (the
  // native-host reload primitive, view-manager.ts attachNativeSimulator).
  useEffect(() => {
    if (compileStatus.status !== 'ready') return
    if (!simulatorUrl) return

    const isHotReload = hotReloadToken !== attachedHotReloadTokenRef.current
    attachedHotReloadTokenRef.current = hotReloadToken

    let attachUrl = simulatorUrl
    if (isHotReload) {
      // Reload at the page the user is looking at (the onSimulatorCurrentPage
      // mirror), not the configured startPage — the native equivalent of the
      // old `collapseRouteToTopPage` semantics. The startPage's queryParams
      // belong to the startPage only and must not leak onto another page.
      const ctx = hotReloadContextRef.current
      if (ctx.appInfo && ctx.port) {
        const reloadPage = ctx.currentPage || ctx.compileConfig.startPage
        attachUrl = buildSimulatorUrl(
          ctx.appInfo.appId,
          reloadPage === ctx.compileConfig.startPage
            ? ctx.compileConfig
            : { ...ctx.compileConfig, startPage: reloadPage, queryParams: [] },
          ctx.port,
        )
      }
    }

    // Push the device BEFORE attaching: main caches it so the simulator WCV's
    // preload picks it up synchronously (NATIVE_HOST_ENABLED reply), letting the
    // DeviceShell mount at the right bezel size / notch without a flash.
    sendDeviceInfo(deviceRef.current!)
    let cancelled = false
    let captureTimer: number | null = null

    const scheduleThumbnail = (): void => {
      if (cancelled) return
      // Short paint grace period from the readiness point (hard path: attach
      // resolves at the first render guest's did-finish-load; soft path: the
      // in-place swap completes well within it).
      captureTimer = window.setTimeout(() => {
        if (!cancelled) {
          void captureThumbnail(projectPath).catch(() => {})
        }
      }, 3_000)
    }

    const hardAttach = (): void => {
      void attachNativeSimulator(attachUrl, simPanelWidthRef.current!)
        .then(scheduleThumbnail)
        .catch(() => {
          // Attach failures are surfaced by the simulator path. Thumbnail
          // capture is best-effort and must not add an unhandled rejection.
        })
    }

    if (isHotReload) {
      // Soft-first: ask main to RELAUNCH the live DeviceShell in place (the
      // phone shell never unmounts; the new session swaps in when ready). Only
      // `true` means accepted — anything else (no live+ready shell, lenient
      // invoke swallowing a failure) falls back to the hard rebuild.
      void softReloadNativeSimulator(attachUrl)
        .then((accepted) => {
          if (cancelled) return
          if (accepted === true) {
            scheduleThumbnail()
            return
          }
          hardAttach()
        })
        .catch(() => {
          if (!cancelled) hardAttach()
        })
    } else {
      hardAttach()
    }

    return () => {
      cancelled = true
      if (captureTimer !== null) {
        window.clearTimeout(captureTimer)
      }
    }
  }, [
    compileStatus.status,
    simulatorUrl,
    hotReloadToken,
    simPanelWidthRef,
    deviceRef,
    sendDeviceInfo,
    projectPath,
  ])

  return {
    simulatorUrl,
    currentPage,
  }
}
