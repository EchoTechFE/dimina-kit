/**
 * Sidebar-specific instantiation of `createHostSlotSessionRuntime` (see that
 * module for the full ref-counting contract). Kept as a thin, independently
 * named wrapper — same rationale as `host-toolbar-session-runtime.ts` — so
 * a sidebar-focused test can `vi.resetModules()` this module's state without
 * touching the toolbar's independent ref-count.
 */

import { createHostSlotSessionRuntime } from './host-slot-session-runtime.js'
import { hostSidebarRuntimePreloadPath } from '../../utils/paths.js'

const runtime = createHostSlotSessionRuntime(hostSidebarRuntimePreloadPath)

export function acquireHostSidebarSessionRuntime(): void {
  runtime.acquire()
}

export function releaseHostSidebarSessionRuntime(): void {
  runtime.release()
}
