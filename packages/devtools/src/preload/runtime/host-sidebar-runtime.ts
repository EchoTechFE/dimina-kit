/**
 * Session-resident host-sidebar framework runtime: GUARD + ACTIVATION.
 *
 * Same registration and guard shape as host-toolbar-runtime.ts (see that
 * module for the full rationale): registered once per process on
 * `session.defaultSession`, so it runs in EVERY defaultSession renderer;
 * this guard keeps it inert everywhere except the host-sidebar WCV's main
 * frame, identified by `HOST_SIDEBAR_RUNTIME_MARKER` in that process' argv.
 */

import { HOST_SIDEBAR_RUNTIME_MARKER } from '../../shared/constants.js'
import { installHostSidebarAdvertiserWhenReady } from './host-sidebar-advertiser.js'
import { installHostSidebarPortBridge } from './host-sidebar-port.js'

/**
 * Pure guard predicate: should the sidebar runtime activate in a renderer with
 * this `argv` / `isMainFrame`? True only for the MAIN frame of a process whose
 * argv carries the `'--dimina-host-sidebar'` marker.
 */
export function shouldActivateHostSidebarRuntime(
  argv: readonly string[],
  isMainFrame: boolean,
): boolean {
  return isMainFrame && argv.includes(HOST_SIDEBAR_RUNTIME_MARKER)
}

/**
 * Run the guard; only when it passes, install the width advertiser
 * (`installHostSidebarAdvertiserWhenReady`) and the narrow-channel page
 * bridge (`installHostSidebarPortBridge` — `window.diminaHostSidebar` +
 * the MessagePort handshake listener). Returns whether the runtime
 * activated. A failed guard installs NOTHING (zero footprint in non-sidebar
 * windows and subframes: no advertiser, no bridge key, no IPC listener).
 */
export function activateHostSidebarRuntime(env: {
  argv: readonly string[]
  isMainFrame: boolean
}): boolean {
  if (!shouldActivateHostSidebarRuntime(env.argv, env.isMainFrame)) return false
  installHostSidebarAdvertiserWhenReady()
  installHostSidebarPortBridge()
  return true
}
