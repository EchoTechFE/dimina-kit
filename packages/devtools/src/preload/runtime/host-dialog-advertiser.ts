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

/**
 * Attach both axis advertisers to the dialog content's shrink-to-fit root
 * (`[data-host-dialog-root]`). That element MUST be shrink-to-fit on BOTH
 * axes — same footgun as the toolbar/sidebar (`createSizeAdvertiser`'s
 * single-axis-ownership requirement), just doubled. If the element is
 * missing we warn and no-op rather than measure `<body>`, whose size IS the
 * view size and would advertise nonsense.
 *
 * Returns a disposer that tears both advertisers down.
 */
export function installHostDialogAdvertiser(): () => void {
  const root = document.querySelector<HTMLElement>('[data-host-dialog-root]')
  if (!root) {
    console.warn(
      '[host-dialog-advertiser] no `[data-host-dialog-root]` element found — ' +
        'not advertising a size. The dialog content must wrap itself in a ' +
        'shrink-to-fit `[data-host-dialog-root]` element so its size is the ' +
        'content size, not the host-given view size.',
    )
    return () => {}
  }

  const publish = (size: { axis: 'block' | 'inline'; extent: number }): void => {
    ipcRenderer.send(ViewChannel.HostDialogAdvertiseSize, size)
  }

  const blockAdvertiser = createSizeAdvertiser(root, { axis: 'block', publish })
  const inlineAdvertiser = createSizeAdvertiser(root, { axis: 'inline', publish })

  return () => {
    blockAdvertiser.dispose()
    inlineAdvertiser.dispose()
  }
}

/**
 * Install once the DOM is ready (the root element must exist before we query).
 * Self-gating: if the document is already past `loading`, install synchronously;
 * otherwise wait for `DOMContentLoaded`.
 */
export function installHostDialogAdvertiserWhenReady(): void {
  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        installHostDialogAdvertiser()
      },
      { once: true },
    )
  } else {
    installHostDialogAdvertiser()
  }
}
