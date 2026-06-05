/**
 * Adapter: devtools' trust state → the `{ ipcMain, trustedWebContents,
 * senderPolicy }` triple that `@dimina-kit/workbench`'s `WireTransport` needs.
 *
 * Trust domain (important): the WireTransport owns a NARROW, host-declared
 * channel set (`__workbench:probe|invoke|event`) carrying only the host's
 * declared `hostServices` / `events`. Its trusted set is therefore the
 * host-shell's own webviews — the main window, any host-trusted windows, AND
 * the host-owned toolbar. This is deliberately DIFFERENT from `ctx.senderPolicy`
 * (the global devtools IpcRegistry policy over ~72 channels), which excludes the
 * host-toolbar so arbitrary toolbar content can't reach internal devtools IPC.
 * Reusing `ctx.senderPolicy` here would lock the toolbar — the primary consumer
 * of hostServices/events — out of the very transport built for it.
 *
 * So the wire policy = `ctx.senderPolicy` (main + host-trusted windows) UNION
 * the live host-toolbar webContents. Resolution is lazy per call, so it tracks
 * the toolbar view across (re)creation.
 *
 * Pure bridge: building the options attaches no ipcMain listeners/handlers —
 * `WireTransport.start()` owns that.
 */
import { ipcMain, webContents } from 'electron'
import type { IpcMain, WebContents } from 'electron'

import type { SenderPolicy as WorkbenchSenderPolicy } from '@dimina-kit/workbench'
import type { WorkbenchContext } from '../services/workbench-context.js'

export interface WireTransportOptions {
  ipcMain: IpcMain
  trustedWebContents: () => readonly WebContents[]
  senderPolicy: WorkbenchSenderPolicy
}

export function buildWireTransportOptions(ctx: WorkbenchContext): WireTransportOptions {
  /** The host-owned toolbar webContents id, if the view currently exists. */
  const toolbarWcId = (): number | null => ctx.views.hostToolbar.webContents?.id ?? null
  /** Wire-surface trust: global policy (main + host-trusted windows) ∪ toolbar. */
  const isWireTrusted = (wc: WebContents): boolean =>
    wc.id === toolbarWcId() || ctx.senderPolicy(wc)

  return {
    ipcMain,
    trustedWebContents: () => webContents.getAllWebContents().filter(isWireTrusted),
    senderPolicy: {
      isTrusted(senderId: number): boolean {
        const wc = webContents.fromId(senderId)
        if (!wc) return false
        return isWireTrusted(wc)
      },
    },
  }
}
