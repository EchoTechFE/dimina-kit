import {
  clearAppDataSnapshot,
  setAppDataSnapshot,
} from '../runtime/bridge.js'
import type { MiniappSnapshotSource } from '../miniapp-snapshot/types.js'
import {
  AppDataAccumulator,
  decodeOutgoingMessage,
  decodeWorkerMessage,
  type AppDataInput,
  type AppDataSnapshot,
} from '@dimina-kit/inspect'

// Window augmentation is in ../types.ts

// Re-exported so existing importers (use-panel-data, types) keep their
// `from '.../app-data'` path while the cumulative logic lives in the shared,
// framework-agnostic accumulator reused by the native-host main service.
export type { AppDataSnapshot } from '@dimina-kit/inspect'

/**
 * The AppData snapshot data source.
 *
 * Under native-host (the sole runtime) this is registered in the simulator top
 * frame purely for its `start()` side effects — it installs
 * `window.__simulatorHook.appData` and mirrors the flat cache into the
 * `window.__simulatorData.getAppdata()` automation surface still read by
 * automation `getData` (handlers/page.ts), the MCP context overview
 * (mcp/tools/context-tools.ts) and the e2e automator. Its iframe/Worker-based
 * snapshot publishing is inert there (no mini-app Worker runs in the top frame).
 *
 * Instruments `window.Worker` (incoming `message` decoding + outgoing
 * `postMessage` interception) and installs `window.__simulatorHook.appData`,
 * feeding the shared `AppDataAccumulator`. Every accepted mutation — an
 * `ub`/`page_*` worker message, or a `pageUnload` evicting a bridge — calls
 * `emit()` so the `miniappSnapshot` host republishes. The source itself never
 * touches IPC: the host owns push, pull and the install-time publish.
 *
 * It keeps the `__simulatorData.getAppdata()` automation surface working by
 * mirroring the flat cache into the simulator bridge via `setAppDataSnapshot`
 * / `clearAppDataSnapshot`.
 *
 * Under native-host this source is replaced by the main-process
 * simulator-appdata service, which feeds the SAME accumulator from the
 * service→render message stream — see shared/appdata-accumulator.ts.
 */
export function createAppDataSource(): MiniappSnapshotSource<AppDataSnapshot> {
  const accumulator = new AppDataAccumulator()

  let emit: (() => void) | null = null
  let installed = false
  let originalHook: Window['__simulatorHook']
  let originalDescriptor: PropertyDescriptor | undefined
  let OriginalWorker: typeof Worker | undefined

  // Mirror the flat cache into the `__simulatorData.getAppdata()` automation
  // surface so MCP / e2e reads keep working after the snapshot migration.
  function publishSnapshot(): void {
    setAppDataSnapshot(accumulator.flat())
  }

  function clearBridge(bridgeId: string): void {
    accumulator.clearBridge(bridgeId)
    publishSnapshot()
    // The eviction is a cache mutation — notify the host so the renderer can
    // drop the evicted bridge's tab immediately.
    emit?.()
  }

  function applyAppData(body: unknown): void {
    if (!accumulator.apply(body as AppDataInput)) return
    publishSnapshot()
    emit?.()
  }

  function instrumentPostMessage(worker: Worker): void {
    const orig = worker.postMessage.bind(worker) as (msg: unknown, ...rest: unknown[]) => void
    worker.postMessage = function (msg: unknown, ...rest: unknown[]) {
      const decoded = decodeOutgoingMessage(msg)
      if (decoded?.type === 'pageUnload' && decoded.bridgeId) {
        clearBridge(decoded.bridgeId)
      }
      return orig(msg, ...rest)
    } as Worker['postMessage']
  }

  function createInstrumentedWorker(Original: typeof Worker): typeof Worker {
    function InstrumentedWorker(
      this: unknown,
      scriptURL: string | URL,
      options?: WorkerOptions
    ): Worker {
      const resolvedScriptURL = scriptURL instanceof URL
        ? scriptURL
        : new URL(scriptURL, window.location.href)
      const worker = Reflect.construct(
        Original,
        [resolvedScriptURL, options],
        new.target ?? InstrumentedWorker
      ) as Worker

      instrumentPostMessage(worker)

      worker.addEventListener('message', (event: MessageEvent) => {
        const entries = decodeWorkerMessage(event.data)
        if (!entries) return
        for (const entry of entries) {
          const hookBody: AppDataInput = {
            bridgeId: entry.bridgeId,
            moduleId: entry.moduleId,
            data: entry.data,
            mode: entry.mode,
          }
          if (entry.mode === 'init') hookBody.componentPath = entry.componentPath
          window.__simulatorHook?.appData(hookBody)
        }
      })

      return worker
    }

    Object.setPrototypeOf(InstrumentedWorker, Original)
    Object.defineProperty(InstrumentedWorker, 'prototype', {
      value: Original.prototype,
    })

    return InstrumentedWorker as unknown as typeof Worker
  }

  return {
    id: 'appdata',
    snapshot: () => accumulator.snapshot(),
    start(onChange) {
      if (installed) return
      installed = true
      emit = onChange
      originalHook = window.__simulatorHook
      originalDescriptor = Object.getOwnPropertyDescriptor(window, 'Worker')
      OriginalWorker = window.Worker

      window.__simulatorHook = {
        appData: (body: unknown) => applyAppData(body),
      }

      Object.defineProperty(window, 'Worker', {
        configurable: true,
        writable: true,
        value: createInstrumentedWorker(OriginalWorker),
      })
    },
    dispose() {
      if (!installed) return
      installed = false
      if (originalDescriptor) {
        Object.defineProperty(window, 'Worker', originalDescriptor)
      } else if (OriginalWorker) {
        window.Worker = OriginalWorker
      }
      if (originalHook) {
        window.__simulatorHook = originalHook
      } else {
        delete window.__simulatorHook
      }
      originalDescriptor = undefined
      OriginalWorker = undefined
      originalHook = undefined
      accumulator.clear()
      clearAppDataSnapshot()
      emit = null
    },
  }
}
