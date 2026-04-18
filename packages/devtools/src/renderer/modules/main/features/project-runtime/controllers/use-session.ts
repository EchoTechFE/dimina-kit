import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { RefObject } from 'react'
import {
  getCompileConfig,
  getPreloadPath,
  getProjectPages,
  onProjectStatus,
  openProject,
  saveCompileConfig,
} from '@/shared/api'
import type { AppInfo } from '@/shared/api'
import {
  buildSimulatorUrl,
} from '@/shared/lib/simulator-url'
import type { CompileConfig } from '@/shared/types'
import { DEFAULT_SCENE } from '../../../../../../shared/constants'
import { asWebview } from './webview-helpers'
import type { CompileStatus } from './use-project-runtime-controller'

export interface UseSessionProps {
  projectPath: string
  simulatorRef: RefObject<HTMLElement | null>
}

export interface SessionHookResult {
  compileStatus: CompileStatus
  appInfo: AppInfo | null
  port: number
  pages: string[]
  compileConfig: CompileConfig
  preloadPath: string
  relaunch: (nextConfig?: CompileConfig) => Promise<void>
}

export function useSession(props: UseSessionProps): SessionHookResult {
  const { projectPath, simulatorRef } = props

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
  const [preloadPath, setPreloadPath] = useState('')

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

        setAppInfo(result.appInfo)
        setPort(result.port)
        const [pagesResult, config] = await Promise.all([
          getProjectPages(projectPath),
          getCompileConfig(projectPath),
        ])
        if (cancelled) return

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

  useEffect(() => {
    void getPreloadPath().then(setPreloadPath)
  }, [])

  useEffect(() => {
    return onProjectStatus((data) => setCompileStatus(data))
  }, [])

  const isRefreshing = useRef(false)
  const cleanupRelaunchRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    return () => {
      cleanupRelaunchRef.current?.()
    }
  }, [])

  const relaunch = useCallback(
    async (nextConfig: CompileConfig = compileConfig) => {
      try {
        if (!appInfo?.appId || isRefreshing.current) return

        const webview = asWebview(simulatorRef)
        if (!webview) return

        cleanupRelaunchRef.current?.()
        cleanupRelaunchRef.current = null

        isRefreshing.current = true

        await saveCompileConfig(projectPath, nextConfig)
        // DON'T update compileConfig before navigation — that would change
        // simulatorUrl → React updates <webview src> → double navigation
        // with loadURL → ERR_FAILED. Update config AFTER navigation succeeds.
        setCompileStatus({ status: 'ready', message: '正在刷新...' })

        const targetUrl = buildSimulatorUrl(appInfo.appId, nextConfig, port)
        const currentUrl = webview.getURL?.()
        let settled = false
        let timer: ReturnType<typeof setTimeout> | null = null

        const finish = (status: string, message: string) => {
          if (settled) return
          settled = true
          isRefreshing.current = false
          cleanupRelaunchRef.current = null
          if (timer) clearTimeout(timer)
          webview.removeEventListener?.('did-finish-load', onDone as EventListener)
          webview.removeEventListener?.('did-stop-loading', onDone as EventListener)
          webview.removeEventListener?.('did-fail-load', onFail as EventListener)
          // Sync React state with the navigated URL AFTER navigation completes
          setCompileConfig(nextConfig)
          setCompileStatus({ status, message })
        }
        const onDone = () => {
          const current = webview.getURL?.() ?? ''
          const targetHash = targetUrl.split('#')[1] ?? ''
          const currentHash = current.split('#')[1] ?? ''
          if (targetHash && currentHash !== targetHash) return
          finish('ready', '刷新完成')
        }
        const onFail = (_event: Event) => {
          const code = (_event as Event & { errorCode?: number }).errorCode
          if (code === -3) return // ERR_ABORTED from intermediate navigation
          finish('error', '刷新失败')
        }

        webview.addEventListener?.('did-finish-load', onDone as EventListener)
        webview.addEventListener?.('did-stop-loading', onDone as EventListener)
        webview.addEventListener?.('did-fail-load', onFail as EventListener)

        cleanupRelaunchRef.current = () => finish('error', '已取消')

        timer = setTimeout(() => {
          finish('error', '刷新超时')
        }, 30000)

        // Hash-only changes (page switch) don't trigger a full page reload,
        // so the container won't re-read the hash. Always force a full reload:
        // set the URL first, then reload to make the container re-initialize.
        if (currentUrl === targetUrl) {
          webview.reload?.()
        } else {
          webview.loadURL?.(targetUrl)
          // loadURL for hash-only changes is in-page navigation — the
          // container doesn't re-render. Force a full reload after the
          // URL is updated so the container reads the new hash on load.
          setTimeout(() => webview.reload?.(), 100)
        }
      } catch (error) {
        isRefreshing.current = false
        setCompileStatus({
          status: 'error',
          message: error instanceof Error ? error.message : '刷新失败',
        })
      }
    },
    [appInfo, compileConfig, port, projectPath, simulatorRef],
  )

  return {
    compileStatus,
    appInfo,
    port,
    pages,
    compileConfig,
    preloadPath,
    relaunch,
  }
}
