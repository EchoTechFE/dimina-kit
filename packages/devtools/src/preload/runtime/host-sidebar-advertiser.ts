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

/**
 * Attach the advertiser to the sidebar content's shrink-to-fit root
 * (`[data-host-sidebar-root]`). That element MUST be shrink-to-fit on the inline
 * axis — its width must reflect the content, not the host-applied view width,
 * or the cross-process loop never converges (`createSizeAdvertiser`'s footgun).
 * If the element is missing we warn and no-op rather than measure `<body>`,
 * whose inline size IS the view size and would advertise nonsense.
 *
 * Returns a disposer that tears the advertiser down.
 */
export function installHostSidebarAdvertiser(): () => void {
  const root = document.querySelector<HTMLElement>('[data-host-sidebar-root]')
  if (!root) {
    console.warn(
      '[host-sidebar-advertiser] no `[data-host-sidebar-root]` element found — ' +
        'not advertising a width. The sidebar content must wrap itself in a ' +
        'shrink-to-fit `[data-host-sidebar-root]` element so its inline size is ' +
        'the content width, not the host-given view size.',
    )
    return () => {}
  }

  const advertiser = createSizeAdvertiser(root, {
    axis: 'inline',
    publish: (size) => {
      ipcRenderer.send(ViewChannel.HostSidebarAdvertiseWidth, size)
    },
  })

  return () => advertiser.dispose()
}

/**
 * Install once the DOM is ready (the root element must exist before we query).
 * Self-gating: if the document is already past `loading`, install synchronously;
 * otherwise wait for `DOMContentLoaded`.
 */
export function installHostSidebarAdvertiserWhenReady(): void {
  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        installHostSidebarAdvertiser()
      },
      { once: true },
    )
  } else {
    installHostSidebarAdvertiser()
  }
}
