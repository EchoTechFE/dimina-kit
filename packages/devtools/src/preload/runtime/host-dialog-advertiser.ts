/**
 * Reverse size-advertiser preload for the host-controllable dialog
 * WebContentsView. Runs in that WCV's OWN renderer (the dialog content's
 * preload). Unlike the toolbar/sidebar (single-axis persistent strips), the
 * dialog self-sizes on BOTH axes — it has no renderer placeholder to anchor
 * against, so main centers it in the main window purely from what this
 * advertiser reports. Two independent `createSizeAdvertiser` instances (one
 * per axis) share the same root and the same outbound channel
 * (`HostDialogAdvertiseSize` carries `{ axis, extent }` for either axis); main
 * re-centers using whichever axes it has measured so far (see
 * `host-dialog-view.ts`'s `reportMeasuredExtent` / default-size fallback).
 */

import { ipcRenderer } from 'electron'
import { createSizeAdvertiser } from '@dimina-kit/view-anchor'
import { ViewChannel } from '../../shared/ipc-channels-overlays.js'
import { whenSlotRootReady } from './wait-for-slot-root.js'

/**
 * Attach both axis advertisers to the dialog content's shrink-to-fit root
 * (`[data-host-dialog-root]`), waiting for it if necessary — the root may be
 * mounted asynchronously by a framework rather than present in the initial
 * HTML. That element MUST be shrink-to-fit on BOTH axes — same footgun as
 * the toolbar/sidebar (`createSizeAdvertiser`'s single-axis-ownership
 * requirement), just doubled.
 */
export function installHostDialogAdvertiserWhenReady(): void {
  whenSlotRootReady(
    '[data-host-dialog-root]',
    '[host-dialog-advertiser] no `[data-host-dialog-root]` element found — ' +
      'not advertising a size yet. The dialog content must wrap itself in a ' +
      'shrink-to-fit `[data-host-dialog-root]` element so its size is the ' +
      'content size, not the host-given view size.',
    (root) => {
      const publish = (size: { axis: 'block' | 'inline'; extent: number }): void => {
        ipcRenderer.send(ViewChannel.HostDialogAdvertiseSize, size)
      }

      createSizeAdvertiser(root, { axis: 'block', publish })
      createSizeAdvertiser(root, { axis: 'inline', publish })
    },
  )
}
