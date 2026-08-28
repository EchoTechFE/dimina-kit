/**
 * Reverse size-advertiser preload for the host-controllable toolbar
 * WebContentsView. Runs in that WCV's OWN renderer (the toolbar content's
 * preload), measures the toolbar's intrinsic block (height) extent and sends it
 * to the main process. Main pushes the value back to the main-window renderer as
 * `HostToolbarHeightChanged`, which resizes the toolbar placeholder, re-measures
 * the forward anchor, and re-overlays this WCV — closing the dynamic-height loop
 * (see `@dimina-kit/view-anchor` `createSizeAdvertiser`).
 */

import { ipcRenderer } from 'electron'
import { createSizeAdvertiser } from '@dimina-kit/view-anchor'
import { ViewChannel } from '../../shared/ipc-channels-overlays.js'
import { whenSlotRootReady } from './wait-for-slot-root.js'

/**
 * Attach the advertiser to the toolbar content's shrink-to-fit root
 * (`[data-host-toolbar-root]`), waiting for it if necessary — the root may be
 * mounted asynchronously by a framework rather than present in the initial
 * HTML. That element MUST be shrink-to-fit on the block axis — its height
 * must reflect the content, not the host-applied view height, or the
 * cross-process loop never converges (`createSizeAdvertiser`'s footgun).
 */
export function installHostToolbarAdvertiserWhenReady(): void {
  whenSlotRootReady(
    '[data-host-toolbar-root]',
    '[host-toolbar-advertiser] no `[data-host-toolbar-root]` element found — ' +
      'not advertising a height yet. The toolbar content must wrap itself in a ' +
      'shrink-to-fit `[data-host-toolbar-root]` element so its block size is ' +
      'the content height, not the host-given view size.',
    (root) => {
      createSizeAdvertiser(root, {
        axis: 'block',
        publish: (size) => {
          ipcRenderer.send(ViewChannel.HostToolbarAdvertiseHeight, size)
        },
      })
    },
  )
}
