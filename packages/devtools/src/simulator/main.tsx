import { useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { Application, MiniApp } from 'container-api'
import { directRequest } from './direct-request'
import { simulatorApis } from './simulator-api'
import { registerCustomApis } from './custom-api-boot'
import { resolveCustomApisBridge } from './resolve-custom-apis-bridge'
import { parseLocationRoute } from '../shared/simulator-route'

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

let currentMiniApp: MiniApp | null = null

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
    const handler = currentMiniApp?.apiRegistry[name]
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

// ── Simulator component ───────────────────────────────────────────────────────

function SimulatorApp() {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    // The boot sequence awaits the custom-API bridge before presenting the
    // view, so it has to be async. `cancelled` guards against presenting onto
    // a component that unmounted during that await.
    let cancelled = false

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
      miniApp.registerApi('request', directRequest as (...args: unknown[]) => unknown)
      for (const [name, handler] of Object.entries(
        simulatorApis as Record<string, (...args: unknown[]) => unknown>,
      )) {
        miniApp.registerApi(name, handler)
      }

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

      void application.presentView(miniApp, false)
    }

    void boot()

    return () => {
      cancelled = true
    }
  }, [])

  return <div ref={containerRef} style={{ height: '100%' }} />
}

createRoot(document.getElementById('root')!).render(<SimulatorApp />)
