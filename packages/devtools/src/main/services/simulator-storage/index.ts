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

import { app, ipcMain, webContents as wcStatic, type WebContents } from 'electron'
import {
  SimulatorStorageChannel,
  type StorageItem,
} from '../../../shared/ipc-channels.js'

let attachedWc: WebContents | null = null
let hostWc: WebContents | null = null

function isSimulatorWebview(wc: WebContents): boolean {
  if (wc.isDestroyed()) return false
  if (wc.getType() !== 'webview') return false
  return wc.getURL().includes('simulator.html')
}

function detach(): void {
  if (!attachedWc) return
  const wc = attachedWc
  attachedWc = null
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
  detach()
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3')
    }
    await wc.debugger.sendCommand('DOMStorage.enable')
    wc.debugger.on('message', onCdpMessage)
    wc.debugger.on('detach', () => {
      if (attachedWc === wc) attachedWc = null
    })
    wc.once('destroyed', () => {
      if (attachedWc === wc) attachedWc = null
    })
    attachedWc = wc
  } catch (e) {
    console.warn('[storage-watcher] attach failed:', (e as Error).message)
  }
}

function onCdpMessage(_event: Electron.Event, method: string, params: unknown): void {
  if (!hostWc || hostWc.isDestroyed()) return
  const p = params as Record<string, unknown>
  let evt
  switch (method) {
    case 'DOMStorage.domStorageItemAdded':
      evt = { type: 'added' as const, key: String(p.key), newValue: String(p.newValue ?? '') }
      break
    case 'DOMStorage.domStorageItemUpdated':
      evt = {
        type: 'updated' as const,
        key: String(p.key),
        oldValue: String(p.oldValue ?? ''),
        newValue: String(p.newValue ?? ''),
      }
      break
    case 'DOMStorage.domStorageItemRemoved':
      evt = { type: 'removed' as const, key: String(p.key) }
      break
    case 'DOMStorage.domStorageItemsCleared':
      evt = { type: 'cleared' as const }
      break
    default:
      return
  }
  hostWc.send(SimulatorStorageChannel.Event, evt)
}

async function getSnapshot(): Promise<StorageItem[]> {
  if (!attachedWc || attachedWc.isDestroyed()) return []
  try {
    const origin = await attachedWc.executeJavaScript('location.origin')
    const result = (await attachedWc.debugger.sendCommand('DOMStorage.getDOMStorageItems', {
      storageId: { securityOrigin: origin, isLocalStorage: true },
    })) as { entries: Array<[string, string]> }
    return result.entries.map(([key, value]) => ({ key, value }))
  } catch {
    return []
  }
}

export function setupSimulatorStorage(host: WebContents): void {
  hostWc = host

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
  app.on('web-contents-created', (_event, wc) => {
    wc.on('did-finish-load', () => {
      if (isSimulatorWebview(wc)) {
        void attachToSim(wc)
      }
    })
    wc.on('did-navigate-in-page', () => {
      // Project switched but same webview — attach already correct, debugger
      // session survives in-page navigations. No-op.
    })
  })

  ipcMain.handle(SimulatorStorageChannel.GetSnapshot, getSnapshot)
}
