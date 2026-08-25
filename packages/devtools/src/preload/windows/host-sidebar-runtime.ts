// Session-registered sidebar-runtime preload entry.
//
// Bundled into a single CJS file (dist/preload/windows/host-sidebar-runtime.cjs)
// via build:preload and registered ONCE per process on `session.defaultSession`
// (`registerPreloadScript({ type: 'frame', … })` — see
// `src/main/services/views/host-sidebar-session-runtime.ts`). It therefore runs
// in EVERY defaultSession renderer; `activateHostSidebarRuntime`'s guard
// (`process.isMainFrame && process.argv.includes('--dimina-host-sidebar')`)
// makes it a zero-footprint no-op everywhere except the host-sidebar WCV's
// main frame, where it installs the reverse size-advertiser.
import { activateHostSidebarRuntime } from '../runtime/host-sidebar-runtime.js'

activateHostSidebarRuntime({ argv: process.argv, isMainFrame: process.isMainFrame })
