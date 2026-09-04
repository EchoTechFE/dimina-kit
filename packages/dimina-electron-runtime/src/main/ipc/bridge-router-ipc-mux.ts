/**
 * Process-wide multiplexing for the bridge router's `ipcMain` channels.
 *
 * `installBridgeRouter` is per-window assembly: every workbench window gets its
 * own router closure over its own `RouterState`. `ipcMain.handle` accepts
 * exactly ONE handler per channel process-wide and throws on a second, and
 * `event.returnValue` on a sync channel is single-valued — so with several
 * windows open the invoke channels would fail to install and the sync reply
 * would come from whichever router answered last. The mux (shared with
 * devtools' own per-window panel services — see
 * @dimina-kit/electron-deck/main's ipc-mux.ts) installs a single real
 * registration per channel and dispatches each message to the router that
 * owns the calling webContents.
 */

import { ipcMain } from 'electron'
import type { BrowserWindow, WebContents } from 'electron'
import {
  addMuxedInvokeHandler as muxInvoke,
  addMuxedSyncListener as muxSync,
  windowHostsWebContents,
  type InvokeMuxEntry,
  type SyncMuxEntry,
} from '@dimina-kit/electron-deck/main'

// The mux takes `ipcMain` from its caller so that nothing in
// @dimina-kit/electron-deck/main imports a value from `electron`; this package
// already does, so it binds the real one here.
export const addMuxedInvokeHandler = (channel: string, entry: InvokeMuxEntry): (() => void) =>
  muxInvoke(ipcMain, channel, entry)
export const addMuxedSyncListener = (channel: string, entry: SyncMuxEntry): (() => void) =>
  muxSync(ipcMain, channel, entry)

/**
 * The webContents ledgers a router keeps. A sender recorded in any of them was
 * bound by THIS router, so it belongs to it — this is what makes the hidden
 * service-host window (a standalone BrowserWindow, hosted by no workbench
 * window) resolve to the router that spawned it.
 */
export interface RouterSenderLedger {
  serviceWcIdToAppSessionId: Map<number, string>
  simulatorWcIdToAppSessionIds: Map<number, Set<string>>
  wcIdToBridgeId: Map<number, string>
}

/**
 * Whether the router holding `ledger` and driving `win` owns `wc`.
 *
 * The ledgers answer for senders the router already knows (render guests,
 * simulator, and the out-of-window service host). The window check answers for
 * a sender's FIRST message — a spawn arrives from the device shell before any
 * ledger entry exists, but that shell is always inside its own window.
 */
export function routerOwnsSender(
  ledger: RouterSenderLedger,
  win: BrowserWindow | undefined,
  wc: WebContents | undefined,
): boolean {
  if (!wc || wc.isDestroyed()) return false
  if (ledger.serviceWcIdToAppSessionId.has(wc.id)) return true
  if (ledger.simulatorWcIdToAppSessionIds.has(wc.id)) return true
  if (ledger.wcIdToBridgeId.has(wc.id)) return true
  return windowHostsWebContents(win, wc)
}
