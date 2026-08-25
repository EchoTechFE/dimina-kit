/**
 * Sidebar-specific instantiation of `createHostSlotPortChannel` (see that
 * module for the full per-load handshake / navigation-invalidation
 * contract).
 */

import type { WebContents } from 'electron'
import { ViewChannel } from '../../../shared/ipc-channels-overlays.js'
import {
  createHostSlotPortChannel,
  type HostSlotMessageSubscription,
  type HostSlotPortChannel,
} from './host-slot-port-channel.js'

export type HostSidebarMessageSubscription = HostSlotMessageSubscription
export type HostSidebarPortChannel = HostSlotPortChannel

export function createHostSidebarPortChannel(opts: {
  /**
   * Is `wc` still the manager's CURRENT live sidebar webContents? Guards a
   * stale wc's late `did-finish-load` from hijacking the channel after a
   * rebuild swapped the view out underneath it.
   */
  isCurrent: (wc: WebContents) => boolean
}): HostSidebarPortChannel {
  return createHostSlotPortChannel({
    isCurrent: opts.isCurrent,
    channel: ViewChannel.HostSidebarPort,
    logPrefix: '[host-sidebar]',
  })
}
