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
import { ViewChannel } from '../../shared/ipc-channels.js'

/**
 * Attach the advertiser to the toolbar content's shrink-to-fit root
 * (`[data-host-toolbar-root]`). That element MUST be shrink-to-fit on the block
 * axis — its height must reflect the content, not the host-applied view height,
 * or the cross-process loop never converges (`createSizeAdvertiser`'s footgun).
 * If the element is missing we warn and no-op rather than measure `<body>`,
 * whose block size IS the view size and would advertise nonsense.
 *
 * Returns a disposer that tears the advertiser down.
 */
export function installHostToolbarAdvertiser(): () => void {
  const root = document.querySelector<HTMLElement>('[data-host-toolbar-root]')
  if (!root) {
    console.warn(
      '[host-toolbar-advertiser] no `[data-host-toolbar-root]` element found — ' +
        'not advertising a height. The toolbar content must wrap itself in a ' +
        'shrink-to-fit `[data-host-toolbar-root]` element so its block size is ' +
        'the content height, not the host-given view size.',
    )
    return () => {}
  }

  const advertiser = createSizeAdvertiser(root, {
    axis: 'block',
    publish: (size) => {
      ipcRenderer.send(ViewChannel.HostToolbarAdvertiseHeight, size)
    },
  })

  return () => advertiser.dispose()
}

/**
 * Install once the DOM is ready (the root element must exist before we query).
 * Self-gating: if the document is already past `loading`, install synchronously;
 * otherwise wait for `DOMContentLoaded`.
 */
export function installHostToolbarAdvertiserWhenReady(): void {
  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        installHostToolbarAdvertiser()
      },
      { once: true },
    )
  } else {
    installHostToolbarAdvertiser()
  }
}
