/**
 * Native-host current-page push service.
 *
 * The devtools toolbar shows the visible top-of-stack page route. Under
 * native-host the page stack lives in the DeviceShell WebContentsView (each
 * page a nested render-host `<webview>`), not a renderer `<webview>` the main
 * window can observe — so in-app navigation (navigateTo / switchTab / back)
 * never reaches the renderer's `<webview>` did-navigate events. This service
 * taps the bridge's active-page signal and pushes the route — page path plus
 * its launch query, so the simulator's page-path bar shows params just like
 * WeChat DevTools and a recompile can restore them — to the main-window
 * renderer (`SimulatorChannel.CurrentPage`), keeping the toolbar in sync
 * without polling.
 *
 * Inert on the default dimina-fe path (which derives the current page from the
 * simulator `<webview>`'s navigation events); app.ts gates the call on
 * `ctx.bridge.isNativeHost()`.
 */
import type { WebContents } from 'electron'
import { SimulatorChannel } from '../../../shared/ipc-channels.js'
import { encodePageSpec } from '../../../shared/simulator-route.js'
import type { BridgeRouterHandle } from '../../ipc/bridge-router.js'
import { DisposableRegistry, type Disposable } from '@dimina-kit/electron-deck/main'

export interface SimulatorCurrentPageOptions {
  bridge: BridgeRouterHandle
}

export function setupSimulatorCurrentPage(host: WebContents, options: SimulatorCurrentPageOptions): Disposable {
  const registry = new DisposableRegistry()

  // Push the new route whenever the visible top-of-stack page changes. domReady
  // events (same kind stream) carry no pagePath and are ignored; the renderer
  // already seeds the entry route from the launch URL, so the first meaningful
  // update is the first post-boot navigation.
  const off = options.bridge.onRenderEvent((ev) => {
    if (ev.kind !== 'activePage' || !ev.pagePath) return
    if (host.isDestroyed()) return
    // Bridge queries are `Record<string, unknown>` (they may hold numbers from
    // the URL); the route format wants strings. encodePageSpec re-encodes with
    // `?k=v&…` so the renderer can decode it back into { pagePath, query }.
    const query: Record<string, string> = {}
    for (const [k, v] of Object.entries(ev.query ?? {})) query[k] = String(v)
    host.send(SimulatorChannel.CurrentPage, encodePageSpec({ pagePath: ev.pagePath, query }))
  })
  registry.add(off)

  return registry
}
