import { useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { AppManager, Application } from 'container-api'
import { directRequest } from './direct-request'
import { simulatorApis } from './simulator-api'

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

// ── Sync invoke handler (main-thread side) ────────────────────────────────────
// Called by the Worker wrapper's message listener when a __sync_invoke__
// arrives.  Looks up the API handler from the registry, executes it with the
// current MiniApp as context, writes the result into the SharedArrayBuffer,
// and wakes the blocked Worker via Atomics.notify.
window.__handleSyncInvoke = function (sab, msg) {
  const lock = new Int32Array(sab, 0, 1)
  const lenArr = new Int32Array(sab, 4, 1)
  const dataArr = new Uint8Array(sab, 8)

  let result: unknown
  try {
    const { name, params } = msg.body
    const handler = AppManager.apiRegistry[name]
    const miniApp = AppManager.appStack[AppManager.appStack.length - 1]
    if (handler && miniApp) {
      result = handler.call(miniApp, params)
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

    const application = new Application()
    // Upstream MiniApp.getHostEnvSnapshot() walks application.parent.parent.root
    // to locate the iPhone status bar. Devtools mounts Application without a
    // Device wrapper, so expose the host root here; the iphone-chrome query then
    // returns null and the method falls back to its default metrics.
    application.parent = { root: el, updateDeviceBarColor() {} }
    el.appendChild(application.el)

    // Register built-in devtools APIs
    AppManager.registerApi('request', directRequest as (...args: unknown[]) => unknown)
    for (const [name, handler] of Object.entries(
      simulatorApis as Record<string, (...args: unknown[]) => unknown>,
    )) {
      AppManager.registerApi(name, handler)
    }

    // Register proxy handlers for downstream-registered main-process APIs.
    // The bridge is exposed by the simulator preload (installCustomApisBridge);
    // when running outside Electron (e.g. dev-server smoke tests) it is absent
    // and we silently skip. Each proxy forwards (name, params) over IPC.
    const customApisBridge = window.__diminaCustomApis
    if (customApisBridge) {
      customApisBridge.list().then((names) => {
        for (const name of names) {
          AppManager.registerApi(name, (params: unknown) =>
            customApisBridge.invoke(name, params),
          )
        }
      }).catch(() => {
        // Bridge errors are non-fatal — small-app code calling the API will
        // get the same "handler missing" path as an unregistered name.
      })
    }

    // Hash format produced by buildSimulatorUrl: #{appId}|{pagePath}?{query}
    const rawHash = window.location.hash.slice(1)
    const pipeIdx = rawHash.indexOf('|')
    if (pipeIdx === -1) return

    const appId = rawHash.slice(0, pipeIdx)
    const rest = rawHash.slice(pipeIdx + 1)
    const [pagePath, queryStr] = rest.split('?')
    const query: Record<string, string> = {}
    if (queryStr) {
      for (const part of queryStr.split('&')) {
        const eqIdx = part.indexOf('=')
        if (eqIdx === -1) continue
        query[decodeURIComponent(part.slice(0, eqIdx))] = decodeURIComponent(part.slice(eqIdx + 1))
      }
    }
    const scene = Number(query['scene']) || 1001
    const qs = Object.entries(query)
      .filter(([k]) => k !== 'scene')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
    const fullPath = qs ? `${pagePath}?${qs}` : pagePath

    AppManager.openApp(
      {
        appId,
        path: fullPath,
        scene,
        destroy: true,
      },
      application,
    )
  }, [])

  return <div ref={containerRef} style={{ height: '100%' }} />
}

createRoot(document.getElementById('root')!).render(<SimulatorApp />)
