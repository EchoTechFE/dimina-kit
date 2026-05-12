/**
 * Window augmentation types for preload scripts.
 *
 * These define the shape of globals injected into the simulator webview
 * window by our preload/instrumentation code.
 */

import type { Snapshot, StorageSnapshot, WxmlNode } from '../runtime/bridge.js'
import type { ElementInspection } from '../../shared/ipc-channels.js'

/** The simulator data bridge exposed via contextBridge. */
export interface SimulatorDataBridge {
  getAppdata: () => Record<string, unknown>
  getAppdataSnapshot: () => Snapshot<Record<string, unknown>>
  getAppdataGen: () => number
  getStorageSnapshot: () => StorageSnapshot
  getStorageGen: () => number
  getWxml: () => WxmlNode | WxmlNode[] | null
  getWxmlSnapshot: () => Snapshot<WxmlNode | WxmlNode[] | null>
  getWxmlGen: () => number
  refresh: (type: 'wxml' | 'appdata' | 'storage') => void
  highlightElement: (sid: string) => ElementInspection | null
  unhighlightElement: () => void
}

/** Hook interface for app data interception. */
export interface SimulatorHook {
  appData: (body: unknown) => void
}

/** Augmented Window interface for preload globals. */
declare global {
  interface Window {
    __simulatorData?: SimulatorDataBridge
    __deviceInfo?: unknown
    __simulatorHook?: SimulatorHook
  }
}
