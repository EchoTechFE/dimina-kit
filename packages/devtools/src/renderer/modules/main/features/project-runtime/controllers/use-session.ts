import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  getCompileConfig,
  getPreloadPath,
  getProjectPages,
  onProjectStatus,
  openProject,
  saveCompileConfig,
} from '@/shared/api'
import type { AppInfo } from '@/shared/api'
import type { CompileConfig } from '@/shared/types'
import { DEFAULT_SCENE } from '../../../../../../shared/constants'
import type { CompileStatus } from './use-project-runtime-controller'

export interface UseSessionProps {
  projectPath: string
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

  useEffect(() => {
    void getPreloadPath().then(setPreloadPath)
  }, [])

  useEffect(() => {
    return onProjectStatus((data) => {
      setCompileStatus(data)
    })
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
    preloadPath,
    relaunch,
  }
}
