// Session-registered toolbar-runtime preload entry.
//
// Bundled into a single CJS file (dist/preload/windows/host-toolbar-runtime.cjs)
// via build:preload and registered ONCE per process on `session.defaultSession`
// (`registerPreloadScript({ type: 'frame', … })` — see
// `src/main/services/views/host-toolbar-session-runtime.ts`). It therefore runs
// in EVERY defaultSession renderer; `activateHostToolbarRuntime`'s guard
// (`process.isMainFrame && process.argv.includes('--dimina-host-toolbar')`)
// makes it a zero-footprint no-op everywhere except the host-toolbar WCV's
// main frame, where it installs the reverse size-advertiser.
import { activateHostToolbarRuntime } from '../runtime/host-toolbar-runtime.js'

activateHostToolbarRuntime({ argv: process.argv, isMainFrame: process.isMainFrame })
