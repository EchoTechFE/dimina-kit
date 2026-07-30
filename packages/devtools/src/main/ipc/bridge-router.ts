export * from 'dimina-electron-runtime/main/bridge-router'

import { installBridgeRouter as installRuntimeBridgeRouter } from 'dimina-electron-runtime/main/bridge-router'
import {
  createRuntimeEvents,
  type RuntimeContext,
  type RuntimeEvents,
} from 'dimina-electron-runtime/main/runtime-context'
import type { SessionRuntimeStatus, SyncStorageChange } from 'dimina-electron-runtime'
import type { MessageEnvelope } from '../../shared/bridge-channels.js'
import { runtimeAssetPaths } from '../utils/paths.js'

type DevtoolsBridgeContext = Omit<RuntimeContext, 'events'> & {
  events?: RuntimeEvents
  notify?: { sessionRuntimeStatus(payload: SessionRuntimeStatus): void }
  appData?: {
    evictBridge(appId: string, bridgeId: string): void
    onServiceToRender(appId: string, message: MessageEnvelope): void
  }
  onServiceStorageChanged?: (appId: string, change: SyncStorageChange) => void
}

/**
 * DevTools compatibility assembly. New contexts already own RuntimeEvents;
 * narrow historical test/downstream contexts are upgraded here so the runtime
 * package itself stays unaware of panels and renderer notifications.
 */
export function installBridgeRouter(ctx: DevtoolsBridgeContext): void {
  // The DevTools integration owns a complete copy of the runtime assets. Keep
  // compatibility contexts (including embedders/tests that assemble the
  // context manually) on that copy instead of falling back to the standalone
  // package's optional dist assets.
  ctx.assets ??= runtimeAssetPaths

  if (!ctx.events) {
    const events = createRuntimeEvents()
    ctx.events = events
    events.on('session-status', (payload) => ctx.notify?.sessionRuntimeStatus(payload))
    events.on('app-data-evict', ({ appId, bridgeId }) => {
      ctx.appData?.evictBridge(appId, bridgeId)
    })
    events.on('app-data-message', ({ appId, message }) => {
      ctx.appData?.onServiceToRender(appId, message)
    })
    events.on('storage-changed', ({ appId, change }) => {
      ctx.onServiceStorageChanged?.(appId, change)
    })
    ctx.registry.add(() => events.clear())
  }
  installRuntimeBridgeRouter(ctx as RuntimeContext)
}
