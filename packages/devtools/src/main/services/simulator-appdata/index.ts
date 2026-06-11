/**
 * Native-host AppData panel service.
 *
 * Taps the service→render setData stream (bridge-router SERVICE_PUBLISH) — under
 * native-host the service logic runs in the hidden service-host window, not a
 * Worker in the simulator guest, so the default Worker-hook source goes blind.
 * Decodes + accumulates per app via the SHARED `AppDataAccumulator`, mirroring
 * the Storage/WXML main→renderer contract:
 *   - PULL: answers `SimulatorAppDataChannel.GetSnapshot` with the ACTIVE app's
 *     cumulative `accumulator.snapshot()` (empty snapshot when it has no data).
 *   - PUSH: on each accepted message / bridge eviction for the ACTIVE app,
 *     pushes the updated snapshot via `SimulatorAppDataChannel.Event`.
 */
import type { WebContents } from 'electron'
import type { MessageEnvelope } from '../../../shared/bridge-channels.js'
import { SimulatorAppDataChannel } from '../../../shared/ipc-channels.js'
import {
  AppDataAccumulator,
  decodeWorkerMessage,
  decodedToInput,
  type AppDataSnapshot,
} from '../../../shared/appdata-accumulator.js'
import { DisposableRegistry, type Disposable } from '@dimina-kit/electron-deck/main'
import { IpcRegistry, type SenderPolicy } from '../../utils/ipc-registry.js'

export interface AppDataTap {
  /** Feed one service→render message for an app; decodes + accumulates + pushes if active. */
  onServiceToRender(appId: string, msg: MessageEnvelope): void
  /** Evict a page bridge (page teardown) from an app's accumulator; pushes if active. */
  evictBridge(appId: string, bridgeId: string): void
  /** The ACTIVE app's current reactive page state for a bridge (`{}` when none). */
  getPageData(bridgeId: string): Record<string, unknown>
  /** Snapshot all accumulated appdata for an app. Optional for compatibility with tests/mocks. */
  snapshot?: (appId: string) => unknown
}

export interface SimulatorAppDataService extends AppDataTap, Disposable {}

export interface SimulatorAppDataOptions {
  getActiveAppId: () => string | null
  senderPolicy?: SenderPolicy
}

const EMPTY_SNAPSHOT: AppDataSnapshot = { bridges: [], entries: {} }

export function setupSimulatorAppData(
  host: WebContents,
  options: SimulatorAppDataOptions,
): SimulatorAppDataService {
  const { getActiveAppId } = options
  // One accumulator per app — native-host can host multiple sessions; the panel
  // only ever shows the active one (resolved via getActiveAppId).
  const accumulators = new Map<string, AppDataAccumulator>()

  function accumulatorFor(appId: string): AppDataAccumulator {
    let acc = accumulators.get(appId)
    if (!acc) {
      acc = new AppDataAccumulator()
      accumulators.set(appId, acc)
    }
    return acc
  }

  /** Push the active app's snapshot to the renderer (no-op for non-active/destroyed). */
  function pushIfActive(appId: string): void {
    if (appId !== getActiveAppId()) return
    if (host.isDestroyed()) return
    host.send(SimulatorAppDataChannel.Event, accumulatorFor(appId).snapshot())
  }

  function onServiceToRender(appId: string, msg: MessageEnvelope): void {
    const entries = decodeWorkerMessage(msg)
    if (!entries) return
    const acc = accumulatorFor(appId)
    let mutated = false
    for (const entry of entries) {
      if (acc.apply(decodedToInput(entry))) mutated = true
    }
    if (mutated) pushIfActive(appId)
  }

  function evictBridge(appId: string, bridgeId: string): void {
    accumulatorFor(appId).clearBridge(bridgeId)
    pushIfActive(appId)
  }

  function getPageData(bridgeId: string): Record<string, unknown> {
    const activeAppId = getActiveAppId()
    if (!activeAppId) return {}
    return accumulators.get(activeAppId)?.pageData(bridgeId) ?? {}
  }

  const ipc = new IpcRegistry(options.senderPolicy)
  ipc.handle(SimulatorAppDataChannel.GetSnapshot, () => {
    const appId = getActiveAppId()
    if (!appId) return EMPTY_SNAPSHOT
    return accumulators.get(appId)?.snapshot() ?? EMPTY_SNAPSHOT
  })

  // disposeAll runs LIFO; add the IPC registry LAST so it is torn down first —
  // its removeHandler then runs synchronously (before the first `await` yields),
  // which callers that `dispose()` without awaiting rely on.
  const registry = new DisposableRegistry()
  registry.add(() => accumulators.clear())
  registry.add(ipc)

  return {
    onServiceToRender,
    evictBridge,
    getPageData,
    snapshot: (appId) => accumulatorFor(appId).snapshot(),
    dispose: () => registry.dispose(),
  }
}
