import { lazy, Suspense, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { directRequest } from './direct-request'
import { simulatorApis } from './simulator-api'
import { registerCustomApis } from './custom-api-boot'
import { resolveCustomApisBridge } from './resolve-custom-apis-bridge'
import { parseLocationRoute } from '../shared/simulator-route'
import type { SimulatorMiniApp } from './simulator-mini-app'

// The native-host render tree (DeviceShell + device-shell.css) is code-split so
// the simulator entry bundle stays small; the chunk is fetched lazily on boot.
// (SimulatorMiniApp is dynamically imported inside bootNative below.)
const DeviceShell = lazy(() =>
  import('./device-shell/device-shell').then((m) => ({ default: m.DeviceShell })),
)

declare global {
  interface Window {
    __diminaCustomApis?: {
      list: () => Promise<string[]>
      invoke: (name: string, params: unknown) => Promise<unknown>
    }
  }
}

// Register the built-in devtools APIs (request + simulatorApis) on the mini-app
// instance. `SimulatorMiniApp` exposes `registerApi(name, handler)`.
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
  // Set once the native-host pipeline has spawned, switching the render output
  // to the DeviceShell.
  const [nativeShell, setNativeShell] = useState<{
    miniApp: SimulatorMiniApp
    bridgeId: string
  } | null>(null)

  useEffect(() => {
    // The boot sequence awaits the custom-API bridge before presenting the
    // view, so it has to be async. `cancelled` guards against presenting onto
    // a component that unmounted during that await.
    let cancelled = false

    // ── Native-host render path (the sole runtime) ────────────────────────────
    // Boot the DeviceShell + SimulatorMiniApp pipeline (logic in a hidden
    // service-host window, each page in its own render-host <webview>).
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
        registerBuiltinApis(miniApp)
        // Land custom-API proxies before the runtime enumerates its surface
        // (see custom-api-boot.ts). A hung/absent bridge degrades to "no custom
        // APIs" rather than blocking the boot.
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
  }, [])

  return (
    <Suspense fallback={null}>
      {nativeShell ? (
        <DeviceShell
          miniApp={nativeShell.miniApp}
          bridgeId={nativeShell.bridgeId}
          platform={nativeShell.miniApp.platform}
        />
      ) : null}
    </Suspense>
  )
}

createRoot(document.getElementById('root')!).render(<SimulatorApp />)
