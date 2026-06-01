import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Application, MiniApp } from 'container-api'
import { directRequest } from './direct-request'
import { simulatorApis } from './simulator-api'
import { registerCustomApis } from './custom-api-boot'
import { resolveCustomApisBridge } from './resolve-custom-apis-bridge'
import { parseLocationRoute } from '../shared/simulator-route'
import type { SimulatorMiniApp } from './simulator-mini-app'

// The native-host render path is code-split. Importing DeviceShell +
// SimulatorMiniApp statically pulls the native render tree (and
// device-shell.css) into the DEFAULT simulator bundle, which perturbs the
// dimina-fe render (it regressed an automator classList timing assertion).
// Lazy-load so the default bundle is byte-identical to baseline; the chunk is
// fetched only when DIMINA_NATIVE_HOST is on. (SimulatorMiniApp is dynamically
// imported inside bootNative below; the type import above is erased at build.)
const DeviceShell = lazy(() =>
  import('./device-shell/device-shell').then((m) => ({ default: m.DeviceShell })),
)

declare global {
  interface Window {
    __handleSyncInvoke?: (
      sab: SharedArrayBuffer,
      msg: { body: { name: string; params: unknown } },
    ) => void
    __diminaCustomApis?: {
      list: () => Promise<string[]>
      invoke: (name: string, params: unknown) => Promise<unknown>
    }
  }
}

// ── Inject container stylesheet ───────────────────────────────────────────────
// Added programmatically so Vite does not try to bundle the external asset.
const _styleLink = document.createElement('link')
_styleLink.rel = 'stylesheet'
_styleLink.href = '/assets/container.css'
document.head.appendChild(_styleLink)

// The active mini-app instance, for the sync-invoke handler. Either the
// dimina-fe `MiniApp` (default path) or `SimulatorMiniApp` (native-host path);
// both expose `apiRegistry`, which is all `__handleSyncInvoke` needs.
let currentMiniApp: MiniApp | SimulatorMiniApp | null = null

// ── Sync invoke handler (main-thread side) ────────────────────────────────────
// Called by the Worker wrapper's message listener when a __sync_invoke__
// arrives. Reads the handler from the current MiniApp's apiRegistry (the same
// per-instance map upstream's MiniApp.invokeApi consults for async invokes),
// executes it with the MiniApp as context, writes the result into the
// SharedArrayBuffer, and wakes the blocked Worker via Atomics.notify.
window.__handleSyncInvoke = function (sab, msg) {
  const lock = new Int32Array(sab, 0, 1)
  const lenArr = new Int32Array(sab, 4, 1)
  const dataArr = new Uint8Array(sab, 8)

  let result: unknown
  try {
    const { name, params } = msg.body
    const handler = currentMiniApp?.apiRegistry[name] as
      | ((this: unknown, params?: unknown) => unknown)
      | undefined
    if (handler && currentMiniApp) {
      result = handler.call(currentMiniApp, params)
    }
  } catch {
    result = undefined
  }

  const encoded = new TextEncoder().encode(JSON.stringify(result ?? null))
  lenArr[0] = encoded.byteLength
  dataArr.set(encoded)

  Atomics.store(lock, 0, 1)
  Atomics.notify(lock, 0)
}

// Register the built-in devtools APIs (request + simulatorApis) on a mini-app
// instance. Shared by both the dimina-fe and native-host boot paths; both
// `MiniApp` and `SimulatorMiniApp` expose `registerApi(name, handler)`.
function registerBuiltinApis(app: {
  registerApi: (name: string, handler: (...args: unknown[]) => unknown) => void
}): void {
  app.registerApi('request', directRequest as (...args: unknown[]) => unknown)
  for (const [name, handler] of Object.entries(
    simulatorApis as Record<string, (...args: unknown[]) => unknown>,
  )) {
    app.registerApi(name, handler)
  }
}

// ── Simulator component ───────────────────────────────────────────────────────

function SimulatorApp() {
  const containerRef = useRef<HTMLDivElement>(null)
  // Set once the native-host pipeline has spawned, switching the render output
  // from the dimina-fe container to the DeviceShell.
  const [nativeShell, setNativeShell] = useState<{
    miniApp: SimulatorMiniApp
    bridgeId: string
  } | null>(null)

  useEffect(() => {
    // The boot sequence awaits the custom-API bridge before presenting the
    // view, so it has to be async. `cancelled` guards against presenting onto
    // a component that unmounted during that await.
    let cancelled = false

    // ── Native-host render path (opt-in via DIMINA_NATIVE_HOST) ───────────────
    // The simulator preload installs `window.__diminaNativeHost` with `enabled`
    // resolved from the main process via `ipcRenderer.sendSync(NATIVE_HOST_ENABLED)`
    // — the webview guest preload cannot read the launch `process.env` (and
    // additionalArguments don't reach the guest argv), so main is the source of
    // truth. When enabled we boot the DeviceShell + SimulatorMiniApp pipeline
    // (logic in a hidden service-host window, each page in its own render-host
    // <webview>) instead of the default dimina-fe container.
    if (window.__diminaNativeHost?.enabled) {
      const bootNative = async (): Promise<void> => {
        try {
          const route = parseLocationRoute(window.location.search)
          if (!route) return
          const { appId } = route
          const { pagePath, query } = route.entry
          const scene = Number(query['scene']) || 1001
          delete query['scene']

          const { SimulatorMiniApp } = await import('./simulator-mini-app')
          const miniApp = new SimulatorMiniApp({ appId, scene, pagePath, query })
          currentMiniApp = miniApp
          registerBuiltinApis(miniApp)
          // Mirror the dimina-fe path: land custom-API proxies before the runtime
          // enumerates its surface (see custom-api-boot.ts). A hung/absent bridge
          // degrades to "no custom APIs" rather than blocking the boot.
          await registerCustomApis(miniApp, resolveCustomApisBridge())
          if (cancelled) return
          const bridgeId = await miniApp.spawn()
          if (cancelled) return
          setNativeShell({ miniApp, bridgeId })
        } catch (err) {
          console.error('[simulator] native-host boot failed:', err)
        }
      }
      void bootNative()
      return () => {
        cancelled = true
      }
    }

    // ── Default dimina-fe path (unchanged) ────────────────────────────────────
    const el = containerRef.current
    if (!el) return

    const boot = async (): Promise<void> => {
      const application = new Application()

      // Status bar shim — upstream MiniApp.getSystemInfoAsync DOM-queries
      // `parent.parent.root.querySelector('.iphone__status-bar').getBoundingClientRect()`.
      // Devtools mounts Application without the Device iPhone chrome, so we inject
      // a zero-size placeholder here to keep that lookup non-null.
      const fakeStatusBar = document.createElement('div')
      fakeStatusBar.className = 'iphone__status-bar'
      fakeStatusBar.style.cssText = 'position:absolute;width:0;height:0;'
      el.appendChild(fakeStatusBar)

      // Upstream MiniApp.getHostEnvSnapshot() walks application.parent.parent.root.
      // Devtools mounts Application without a Device wrapper, so expose the host
      // root here; the status-bar lookup then resolves to the shim above.
      application.parent = { root: el, updateDeviceBarColor() {} }
      el.appendChild(application.el)

      // URL format produced by buildSimulatorUrl + maintained by upstream
      // HashRouter.syncStack: ?appId={id}&entry={path?perPageQuery}&page={...}.
      const route = parseLocationRoute(window.location.search)
      if (!route) return
      const { appId } = route
      const { pagePath, query } = route.entry
      const scene = Number(query['scene']) || 1001
      // `scene` is a launch param, not a page param. Keeping it would
      // round-trip through HashRouter.syncStack into the entry-page segment.
      delete query['scene']

      // Upstream AppManager.openApp pulls (name, logo) from a static getMiniAppInfo
      // table; simulator runs arbitrary appIds that don't live in that table, so
      // we construct MiniApp directly and pass identity defaults.
      const miniApp = new MiniApp({
        appId,
        scene,
        name: appId,
        logo: '',
        pagePath,
        query,
      })
      currentMiniApp = miniApp

      // Register built-in devtools APIs on the MiniApp instance (upstream
      // per-instance API from PR #189). MiniApp.invokeApi consults
      // `this.apiRegistry` for async invokes; __handleSyncInvoke above does the
      // same lookup for sync invokes.
      registerBuiltinApis(miniApp)

      // Register proxy handlers for downstream-registered main-process APIs
      // *before* presenting the view. registerCustomApis awaits the bridge's
      // name list, so the proxies land on miniApp.apiRegistry before the
      // mini-app runtime boots and enumerates its API surface — notably
      // Taro's one-shot `Object.keys(wx)` at init, which silently drops APIs
      // that register late. A rejected/hung bridge degrades to "no custom
      // APIs" rather than blocking the boot (see custom-api-boot.ts).
      // `resolveCustomApisBridge` resolves `window.__diminaCustomApis` and, if
      // it is missing inside Electron, warns that a custom preload forgot
      // `installCustomApisBridge()` — otherwise the failure is silent.
      await registerCustomApis(miniApp, resolveCustomApisBridge())
      if (cancelled) return

      // Expose MiniApp's TabBar + routing instance methods on the simulator
      // top-window `wx` so miniprogram-automator's `App.callWxMethod` (which
      // runs `wx.${method}(...)` against the simulator's top frame, not the
      // page iframe) can drive them. Mini-app source code calls these via the
      // service-side `wx`, which dimina-fe routes through its own jsbridge;
      // this surface is a *automation-only mirror* of that, so the wechat
      // automation CLI can exercise tab-bar APIs without us altering the
      // service runtime.
      const w = window as unknown as { wx?: Record<string, unknown> }
      w.wx = w.wx || {}
      const exposedWxMethods = [
        // Routing (top-window mirror so callWxMethod can drive them when the
        // page-iframe wx doesn't expose them — jdimina only puts a partial
        // surface on the iframe wx).
        'navigateTo', 'navigateBack', 'redirectTo', 'reLaunch', 'switchTab',
        // NavigationBar dynamic APIs.
        'setNavigationBarTitle', 'setNavigationBarColor',
        // TabBar dynamic APIs.
        'showTabBar', 'hideTabBar',
        'setTabBarBadge', 'removeTabBarBadge',
        'showTabBarRedDot', 'hideTabBarRedDot',
        'setTabBarItem', 'setTabBarStyle',
      ] as const
      for (const m of exposedWxMethods) {
        const fn = (miniApp as unknown as Record<string, unknown>)[m]
        if (typeof fn === 'function') {
          w.wx[m] = (fn as (...args: unknown[]) => unknown).bind(miniApp)
        }
      }

      void application.presentView(miniApp, false)
    }

    void boot()

    return () => {
      cancelled = true
    }
  }, [])

  if (nativeShell) {
    return (
      <Suspense fallback={null}>
        <DeviceShell
          miniApp={nativeShell.miniApp}
          bridgeId={nativeShell.bridgeId}
          platform={nativeShell.miniApp.platform}
        />
      </Suspense>
    )
  }
  return <div ref={containerRef} style={{ height: '100%' }} />
}

createRoot(document.getElementById('root')!).render(<SimulatorApp />)
