/**
 * Session-resident host-dialog framework runtime: GUARD + ACTIVATION.
 *
 * Same registration and guard shape as host-toolbar-runtime.ts (see that
 * module for the full rationale): registered once per process on
 * `session.defaultSession`, so it runs in EVERY defaultSession renderer;
 * this guard keeps it inert everywhere except the host-dialog WCV's main
 * frame, identified by `HOST_DIALOG_RUNTIME_MARKER` in that process' argv.
 */

import { HOST_DIALOG_RUNTIME_MARKER } from '../../shared/constants.js'
import { installHostDialogAdvertiserWhenReady } from './host-dialog-advertiser.js'
import { installHostDialogPortBridge } from './host-dialog-port.js'

/**
 * Pure guard predicate: should the dialog runtime activate in a renderer with
 * this `argv` / `isMainFrame`? True only for the MAIN frame of a process whose
 * argv carries the `'--dimina-host-dialog'` marker.
 */
export function shouldActivateHostDialogRuntime(
  argv: readonly string[],
  isMainFrame: boolean,
): boolean {
  return isMainFrame && argv.includes(HOST_DIALOG_RUNTIME_MARKER)
}

/**
 * Run the guard; only when it passes, install the dual-axis size advertiser
 * (`installHostDialogAdvertiserWhenReady`) and the narrow-channel page
 * bridge (`installHostDialogPortBridge` — `window.diminaHostDialog` +
 * the MessagePort handshake listener). Returns whether the runtime
 * activated. A failed guard installs NOTHING (zero footprint in non-dialog
 * windows and subframes: no advertiser, no bridge key, no IPC listener).
 */
export function activateHostDialogRuntime(env: {
  argv: readonly string[]
  isMainFrame: boolean
}): boolean {
  if (!shouldActivateHostDialogRuntime(env.argv, env.isMainFrame)) return false
  installHostDialogAdvertiserWhenReady()
  installHostDialogPortBridge()
  return true
}
