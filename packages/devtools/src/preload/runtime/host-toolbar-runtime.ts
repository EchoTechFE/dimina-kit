/**
 * Session-resident host-toolbar framework runtime: GUARD + ACTIVATION.
 *
 * The toolbar-runtime preload is registered on `session.defaultSession` via
 * `registerPreloadScript({ type: 'frame', … })`, so it executes in EVERY
 * defaultSession renderer — the main window, settings/popover overlays, and
 * (with `nodeIntegrationInSubFrames`) even subframes. This module is the guard
 * that keeps it inert everywhere except the host-toolbar WCV's main frame:
 *
 *  - the toolbar WCV's creation injects `HOST_TOOLBAR_RUNTIME_MARKER` into its
 *    process argv via `webPreferences.additionalArguments`;
 *  - the marker is PROCESS-level (subframes of the toolbar window carry it
 *    too — spike .repro/wave3-spike/RESULTS.md item 3), so the guard needs
 *    BOTH wings: `isMainFrame` AND `argv.includes(marker)`;
 *  - a renderer that fails the guard returns immediately with ZERO footprint
 *    (no advertiser, no listeners, no globals — spike item 4).
 *
 * Why session-resident at all: the advertiser used to ride the toolbar WCV's
 * `webPreferences.preload`, so a host calling `setPreloadPath(<its own
 * preload>)` REPLACED it and the strip height collapsed to 0. With the runtime
 * on the session layer, the host preload and the framework runtime coexist.
 */

import { HOST_TOOLBAR_RUNTIME_MARKER } from '../../shared/constants.js'
import { installHostToolbarAdvertiserWhenReady } from './host-toolbar-advertiser.js'
import { installHostToolbarPortBridge } from './host-toolbar-port.js'

/**
 * Pure guard predicate: should the toolbar runtime activate in a renderer with
 * this `argv` / `isMainFrame`? True only for the MAIN frame of a process whose
 * argv carries the `'--dimina-host-toolbar'` marker.
 */
export function shouldActivateHostToolbarRuntime(
  argv: readonly string[],
  isMainFrame: boolean,
): boolean {
  return isMainFrame && argv.includes(HOST_TOOLBAR_RUNTIME_MARKER)
}

/**
 * Run the guard; only when it passes, install the height advertiser
 * (`installHostToolbarAdvertiserWhenReady`) and the narrow-channel page
 * bridge (`installHostToolbarPortBridge` — `window.diminaHostToolbar` +
 * the MessagePort handshake listener). Returns whether the runtime
 * activated. A failed guard installs NOTHING (zero footprint in non-toolbar
 * windows and subframes: no advertiser, no bridge key, no IPC listener).
 */
export function activateHostToolbarRuntime(env: {
  argv: readonly string[]
  isMainFrame: boolean
}): boolean {
  if (!shouldActivateHostToolbarRuntime(env.argv, env.isMainFrame)) return false
  installHostToolbarAdvertiserWhenReady()
  installHostToolbarPortBridge()
  return true
}
