/**
 * Dialog-specific instantiation of `createHostSlotSessionRuntime` (see that
 * module for the full ref-counting contract). Kept as a thin, independently
 * named wrapper — same rationale as `host-toolbar-session-runtime.ts` — so
 * a dialog-focused test can `vi.resetModules()` this module's state without
 * touching the toolbar/sidebar's independent ref-counts.
 */

import { createHostSlotSessionRuntime } from './host-slot-session-runtime.js'
import { hostDialogRuntimePreloadPath } from '../../utils/paths.js'

const runtime = createHostSlotSessionRuntime(hostDialogRuntimePreloadPath)

export function acquireHostDialogSessionRuntime(): void {
  runtime.acquire()
}

export function releaseHostDialogSessionRuntime(): void {
  runtime.release()
}
