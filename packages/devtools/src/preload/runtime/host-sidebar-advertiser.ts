/**
 * Reverse size-advertiser preload for the host-controllable sidebar
 * WebContentsView. Runs in that WCV's OWN renderer (the sidebar content's
 * preload), measures the sidebar's intrinsic inline (width) extent and sends it
 * to the main process. Main pushes the value back to the main-window renderer as
 * `HostSidebarWidthChanged`, which resizes the sidebar placeholder, re-measures
 * the forward anchor, and re-overlays this WCV — closing the dynamic-width loop
 * (see `@dimina-kit/view-anchor` `createSizeAdvertiser`).
 */

import { ipcRenderer } from 'electron'
import { createSizeAdvertiser } from '@dimina-kit/view-anchor'
import { ViewChannel } from '../../shared/ipc-channels-overlays.js'
import { whenSlotRootReady } from './wait-for-slot-root.js'

/**
 * Attach the advertiser to the sidebar content's shrink-to-fit root
 * (`[data-host-sidebar-root]`), waiting for it if necessary — the root may be
 * mounted asynchronously by a framework (e.g. React) rather than present in
 * the initial HTML. That element MUST be shrink-to-fit on the inline axis —
 * its width must reflect the content, not the host-applied view width, or the
 * cross-process loop never converges (`createSizeAdvertiser`'s footgun).
 */
export function installHostSidebarAdvertiserWhenReady(): void {
  whenSlotRootReady(
    '[data-host-sidebar-root]',
    '[host-sidebar-advertiser] no `[data-host-sidebar-root]` element found — ' +
      'not advertising a width yet. The sidebar content must wrap itself in a ' +
      'shrink-to-fit `[data-host-sidebar-root]` element so its inline size is ' +
      'the content width, not the host-given view size.',
    (root) => {
      createSizeAdvertiser(root, {
        axis: 'inline',
        publish: (size) => {
          ipcRenderer.send(ViewChannel.HostSidebarAdvertiseWidth, size)
        },
      })
    },
  )
}
