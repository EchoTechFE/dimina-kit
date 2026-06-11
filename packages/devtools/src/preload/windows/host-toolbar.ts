// Preload for the host-controllable toolbar WebContentsView.
//
// Bundled into a single CJS file via build:preload (esbuild) and loaded as the
// toolbar WCV's `preload`. Its only job is to run the reverse size-advertiser:
// it measures the host content's intrinsic height (a shrink-to-fit element the
// host marks `[data-host-toolbar-root]`) and posts it to main on the
// `view:host-toolbar:advertise-height` channel, so the main renderer reserves
// exactly that height and the toolbar tracks it (dynamic height, foundation
// ViewAnchor reverse-advertiser).
import { installHostToolbarAdvertiserWhenReady } from '../runtime/host-toolbar-advertiser.js'

installHostToolbarAdvertiserWhenReady()
