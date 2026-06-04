/**
 * Native-host WXML panel service.
 *
 * Mirrors simulator-storage's main→renderer contract so the renderer WXML panel
 * needs no per-mode branching of its own data shape:
 *   - PULL: answers `SimulatorWxmlChannel.GetSnapshot` by reading the active
 *     render-host guest's WXML tree via the injected RenderInspector.
 *   - PUSH: on bridge render-side activity (domReady / active-page change),
 *     re-reads the tree and pushes `SimulatorWxmlChannel.Event` to the renderer
 *     host — keeping the panel reactive without polling.
 *
 * Only meaningful under native-host (the default dimina-fe path sources WXML
 * from the simulator guest's miniappSnapshot transport); app.ts gates the call
 * on `ctx.bridge.isNativeHost()`.
 */
import type { WebContents } from 'electron'
import { SimulatorWxmlChannel } from '../../../shared/ipc-channels.js'
import type { WxmlNode } from '../../../preload/shared/sid-registry.js'
import type { BridgeRouterHandle } from '../../ipc/bridge-router.js'
import { DisposableRegistry, type Disposable } from '../../utils/disposable.js'
import { IpcRegistry, type SenderPolicy } from '../../utils/ipc-registry.js'
import type { RenderInspector } from '../render-inspect/index.js'

export interface SimulatorWxmlOptions {
  bridge: BridgeRouterHandle
  inspector: RenderInspector
  getActiveAppId: () => string | null
  /** Sender gate applied to the WXML IPC handler; omitted in unit tests. */
  senderPolicy?: SenderPolicy
}

export function setupSimulatorWxml(host: WebContents, options: SimulatorWxmlOptions): Disposable {
  const { bridge, inspector, getActiveAppId } = options
  const registry = new DisposableRegistry()

  /** Read the WXML tree of the visible page of the active app, or null. */
  async function pull(): Promise<WxmlNode | null> {
    const wc = bridge.getActiveRenderWc(getActiveAppId() ?? undefined)
    if (!wc) return null
    return inspector.getWxml(wc)
  }

  const ipc = new IpcRegistry(options.senderPolicy)
  ipc.handle(SimulatorWxmlChannel.GetSnapshot, () => pull())
  registry.add(ipc)

  // Re-read + push when a page's DOM mounts or the visible page changes.
  const unsubscribe = bridge.onRenderEvent(() => {
    void pull().then((tree) => {
      if (host.isDestroyed()) return
      host.send(SimulatorWxmlChannel.Event, tree)
    })
  })
  registry.add(unsubscribe)

  return registry
}
