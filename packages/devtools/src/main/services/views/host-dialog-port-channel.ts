/**
 * Dialog-specific instantiation of `createHostSlotPortChannel` (see that
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

export type HostDialogMessageSubscription = HostSlotMessageSubscription
export type HostDialogPortChannel = HostSlotPortChannel

export function createHostDialogPortChannel(opts: {
  /**
   * Is `wc` still the manager's CURRENT live dialog webContents? Guards a
   * stale wc's late `did-finish-load` from hijacking the channel after a
   * rebuild swapped the view out underneath it.
   */
  isCurrent: (wc: WebContents) => boolean
}): HostDialogPortChannel {
  return createHostSlotPortChannel({
    isCurrent: opts.isCurrent,
    channel: ViewChannel.HostDialogPort,
    logPrefix: '[host-dialog]',
  })
}
