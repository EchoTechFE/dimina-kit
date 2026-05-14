/**
 * SimulatorStorageWatcher
 *
 * Attaches the Chrome DevTools Protocol debugger to the simulator <webview>
 * and forwards `DOMStorage.*` events to the renderer host. Replaces the
 * preload-side localStorage.setItem hook that used to push storage changes
 * via SimulatorChannel.Storage / StorageAll.
 *
 * Trade-offs vs the preload approach:
 *   + Uses standard browser protocol; no preload injection
 *   + Captures every change including ones bypassing wx (api-compat fallback,
 *     direct localStorage.setItem from devtools, etc.)
 *   + Decouples panel UI from dimina runtime's wx implementation
 *   - debugger.attach is mutually exclusive with Chrome DevTools (F12).
 *     If a user opens DevTools on the simulator the debugger detaches and
 *     events stop flowing until they close it.
 */

import { app, webContents as wcStatic, type WebContents } from 'electron'
import {
  SimulatorElementChannel,
  SimulatorStorageChannel,
  type ElementInspection,
  type StorageItem,
} from '../../../shared/ipc-channels.js'
import { DisposableRegistry, type Disposable } from '../../utils/disposable.js'
import { IpcRegistry, type SenderPolicy } from '../../utils/ipc-registry.js'

function isSimulatorWebview(wc: WebContents): boolean {
  if (wc.isDestroyed()) return false
  if (wc.getType() !== 'webview') return false
  return wc.getURL().includes('simulator.html')
}

function safeOff(target: { isDestroyed?: () => boolean; removeListener: (event: string, fn: (...args: unknown[]) => void) => unknown }, event: string, fn: (...args: unknown[]) => void): void {
  try {
    if (target.isDestroyed?.()) return
    target.removeListener(event, fn)
  } catch {
    // best-effort
  }
}

export interface SimulatorStorageOptions {
  /**
   * Sender gate applied to `SimulatorStorageChannel.GetSnapshot`.
   * When provided, the IpcRegistry rejects invocations whose `event.sender`
   * is not whitelisted (typically the workbench-wide policy that allows
   * the main window renderer and overlay views only).
   * Omitted in unit tests that mock the electron module.
   */
  senderPolicy?: SenderPolicy
  /**
   * Returns the appId of the currently-active project session, or null when
   * no session is active. The simulator uses a fixed `persist:simulator`
   * partition + simulator.html origin, so localStorage is shared across
   * every project that has ever opened. The dimina runtime isolates writes
   * with `${appId}_` prefixes; this callback lets the panel filter the
   * CDP snapshot/event stream to the active appId.
   */
  getActiveAppId: () => string | null
}

export function setupSimulatorStorage(
  host: WebContents,
  options: SimulatorStorageOptions,
): Disposable {
  const registry = new DisposableRegistry()
  const getActiveAppId = options.getActiveAppId
  let attachedWc: WebContents | null = null
  let attachDisposables: DisposableRegistry | null = null

  /** Active appId prefix (e.g. `wx123_`), or null when no session is active. */
  function activePrefix(): string | null {
    const appId = getActiveAppId()
    return appId ? `${appId}_` : null
  }

  function detachFromSim(): void {
    if (!attachedWc) return
    const wc = attachedWc
    attachedWc = null
    const ad = attachDisposables
    attachDisposables = null
    if (ad) void ad.disposeAll().catch(() => {})
    try {
      if (!wc.isDestroyed() && wc.debugger.isAttached()) {
        wc.debugger.detach()
      }
    } catch {
      // best-effort
    }
  }

  async function attachToSim(wc: WebContents): Promise<void> {
    if (attachedWc === wc) return
    if (wc.isDestroyed()) return
    detachFromSim()
    try {
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3')
      }
      await wc.debugger.sendCommand('DOMStorage.enable')

      const attach = new DisposableRegistry()
      attachDisposables = attach

      const onMessage = (_event: Electron.Event, method: string, params: unknown) =>
        forwardCdpMessage(method, params)
      wc.debugger.on('message', onMessage)
      attach.add(() => safeOff(wc.debugger as unknown as Parameters<typeof safeOff>[0], 'message', onMessage as (...args: unknown[]) => void))

      const onDetach = () => {
        if (attachedWc === wc) attachedWc = null
      }
      wc.debugger.on('detach', onDetach)
      attach.add(() => safeOff(wc.debugger as unknown as Parameters<typeof safeOff>[0], 'detach', onDetach as (...args: unknown[]) => void))

      const onDestroyed = () => {
        // When the attached wc is destroyed, the lingering attachDisposables
        // hold listener refs to a wc that will never emit again. Dispose the
        // registry here so debugger/wc listeners are removed deterministically
        // and a subsequent attachToSim() starts from a clean slate.
        if (attachedWc === wc) {
          attachedWc = null
          const ad = attachDisposables
          attachDisposables = null
          if (ad) void ad.disposeAll().catch(() => {})
        }
      }
      wc.once('destroyed', onDestroyed)
      attach.add(() => safeOff(wc as unknown as Parameters<typeof safeOff>[0], 'destroyed', onDestroyed as (...args: unknown[]) => void))

      attachedWc = wc
    } catch (e) {
      console.warn('[storage-watcher] attach failed:', (e as Error).message)
    }
  }

  function forwardCdpMessage(method: string, params: unknown): void {
    if (host.isDestroyed()) return
    const p = params as Record<string, unknown>
    const prefix = activePrefix()
    let evt
    switch (method) {
      case 'DOMStorage.domStorageItemAdded': {
        const key = String(p.key)
        if (prefix && !key.startsWith(prefix)) return
        evt = { type: 'added' as const, key, newValue: String(p.newValue ?? '') }
        break
      }
      case 'DOMStorage.domStorageItemUpdated': {
        const key = String(p.key)
        if (prefix && !key.startsWith(prefix)) return
        evt = {
          type: 'updated' as const,
          key,
          oldValue: String(p.oldValue ?? ''),
          newValue: String(p.newValue ?? ''),
        }
        break
      }
      case 'DOMStorage.domStorageItemRemoved': {
        const key = String(p.key)
        if (prefix && !key.startsWith(prefix)) return
        evt = { type: 'removed' as const, key }
        break
      }
      case 'DOMStorage.domStorageItemsCleared':
        // Forwarded unfiltered: this CDP event only fires on a true
        // origin-wide `localStorage.clear()`. The dimina runtime's
        // `wx.clearStorageSync` removes keys one-by-one (see
        // `simulator-api-storage.ts`), so prefix-scoped clears arrive as
        // a stream of `domStorageItemRemoved` events that the filter above
        // handles. Any `cleared` we see here is genuinely a full-origin
        // wipe (e.g. from DevTools console) and should propagate.
        evt = { type: 'cleared' as const }
        break
      default:
        return
    }
    host.send(SimulatorStorageChannel.Event, evt)
  }

  async function getSnapshot(): Promise<StorageItem[]> {
    if (!attachedWc || attachedWc.isDestroyed()) return []
    try {
      const origin = await attachedWc.executeJavaScript('location.origin')
      const result = (await attachedWc.debugger.sendCommand('DOMStorage.getDOMStorageItems', {
        storageId: { securityOrigin: origin, isLocalStorage: true },
      })) as { entries: Array<[string, string]> }
      const prefix = activePrefix()
      const filtered = prefix
        ? result.entries.filter(([key]) => key.startsWith(prefix))
        : result.entries
      // Keys are returned with their `${appId}_` prefix intact; stripping is
      // a follow-up so the panel UI can stay compatible with the raw keys.
      return filtered.map(([key, value]) => ({ key, value }))
    } catch {
      return []
    }
  }

  // Attach to any simulator webview that already exists (project may have
  // been opened before this function runs).
  for (const wc of wcStatic.getAllWebContents()) {
    if (isSimulatorWebview(wc)) {
      void attachToSim(wc)
      break
    }
  }

  // Catch new simulator webviews on creation. did-finish-load is the right
  // moment because getURL() may still be 'about:blank' at creation.
  // Track each per-wc listener so it can be removed on storage dispose,
  // and also self-clean when the wc is destroyed.
  const wcSubs = new Map<WebContents, DisposableRegistry>()
  const onWcCreated = (_event: Electron.Event, wc: WebContents) => {
    const sub = new DisposableRegistry()
    wcSubs.set(wc, sub)

    const onFinishLoad = () => {
      if (isSimulatorWebview(wc)) void attachToSim(wc)
    }
    wc.on('did-finish-load', onFinishLoad)
    sub.add(() => safeOff(wc as unknown as Parameters<typeof safeOff>[0], 'did-finish-load', onFinishLoad as (...args: unknown[]) => void))

    wc.once('destroyed', () => {
      void sub.disposeAll().catch(() => {})
      wcSubs.delete(wc)
    })
  }
  app.on('web-contents-created', onWcCreated)
  registry.add(() => {
    app.removeListener('web-contents-created', onWcCreated)
  })
  registry.add(async () => {
    const subs = Array.from(wcSubs.values())
    wcSubs.clear()
    for (const sub of subs) {
      await sub.disposeAll().catch(() => {})
    }
  })

  // IPC handlers — gated by the workbench SenderPolicy when provided so this
  // module routes through the same C-stage sender white-list as every other
  // workbench-built-in (main-window renderer + overlay views only). Without
  // a policy (unit tests with mocked electron) the registry is a transparent
  // pass-through and still owns the removeHandler lifecycle.
  const ipc = new IpcRegistry(options.senderPolicy)
  ipc.handle(SimulatorStorageChannel.GetSnapshot, () => getSnapshot())
  ipc.handle(SimulatorElementChannel.Inspect, (_event, sid: string) => inspectElement(sid))
  ipc.handle(SimulatorElementChannel.Clear, () => clearElementInspection())
  registry.add(ipc)

  // Detach active CDP session last
  registry.add(() => detachFromSim())

  return registry
}

// Element inspection delegates to the simulator preload's __simulatorData
// bridge via executeJavaScript. Looked up independently from `attachedWc` so
// it keeps working when the user opens Chrome DevTools and the storage
// debugger detaches (debugger.attach is mutually exclusive with F12).
function findSimulatorWebContents(): WebContents | null {
  for (const wc of wcStatic.getAllWebContents()) {
    if (isSimulatorWebview(wc)) return wc
  }
  return null
}

async function inspectElement(sid: string): Promise<ElementInspection | null> {
  if (!sid) return null
  const sim = findSimulatorWebContents()
  if (!sim) return null
  try {
    const result = (await sim.executeJavaScript(
      `window.__simulatorData && window.__simulatorData.highlightElement ? window.__simulatorData.highlightElement(${JSON.stringify(sid)}) : null`,
    )) as ElementInspection | null
    return result ?? null
  } catch (e) {
    console.warn('[simulator-element] inspect failed:', (e as Error).message)
    return null
  }
}

async function clearElementInspection(): Promise<void> {
  const sim = findSimulatorWebContents()
  if (!sim) return
  try {
    await sim.executeJavaScript(
      'window.__simulatorData && window.__simulatorData.unhighlightElement && window.__simulatorData.unhighlightElement()',
    )
  } catch {
    // best-effort
  }
}
