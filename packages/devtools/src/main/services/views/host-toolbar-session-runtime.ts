/**
 * Toolbar-specific instantiation of `createHostSlotSessionRuntime` (see that
 * module for the full ref-counting contract). Kept as a thin, independently
 * named wrapper rather than inlined into `host-toolbar-view.ts` because
 * `host-toolbar-session-preload.test.ts` re-imports this module's state via
 * `vi.resetModules()` per test.
 */

import { createHostSlotSessionRuntime } from './host-slot-session-runtime.js'
import { hostToolbarRuntimePreloadPath } from '../../utils/paths.js'

const runtime = createHostSlotSessionRuntime(hostToolbarRuntimePreloadPath)

export function acquireHostToolbarSessionRuntime(): void {
  runtime.acquire()
}

export function releaseHostToolbarSessionRuntime(): void {
  runtime.release()
}
