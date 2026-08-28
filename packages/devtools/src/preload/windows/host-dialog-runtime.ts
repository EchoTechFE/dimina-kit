// Session-registered dialog-runtime preload entry.
//
// Bundled into a single CJS file (dist/preload/windows/host-dialog-runtime.cjs)
// via build:preload and registered ONCE per process on `session.defaultSession`
// (`registerPreloadScript({ type: 'frame', … })` — see
// `src/main/services/views/host-dialog-session-runtime.ts`). It therefore runs
// in EVERY defaultSession renderer; `activateHostDialogRuntime`'s guard
// (`process.isMainFrame && process.argv.includes('--dimina-host-dialog')`)
// makes it a zero-footprint no-op everywhere except the host-dialog WCV's
// main frame, where it installs the reverse dual-axis size-advertiser.
import { activateHostDialogRuntime } from '../runtime/host-dialog-runtime.js'

activateHostDialogRuntime({ argv: process.argv, isMainFrame: process.isMainFrame })
