/**
 * Pure candidate-ranking rules for the two MCP CDP targets.
 *
 * Split out of target-manager.ts: these functions only rank a raw CDP.List
 * result by URL shape and carry no connection state of their own, so they can
 * be pinned with direct unit tests independent of the connection lifecycle.
 */

import { DMB_PAGEFRAME_DOC_NAME } from '../../../shared/dmb-resource-url.js'
import { targetQuery } from './connection-owner.js'

const SIMULATOR_URL_PATTERN = 'localhost:7788'
// The two renderer entries MCP can drive: a project's workbench window and the
// always-present project list.
const WORKBENCH_ENTRY = 'entries/workbench/index.html'
const PROJECT_LIST_ENTRY = 'entries/main/index.html'
// Native-host: the real mini-app page runs in a nested render-host <webview>
// guest whose CDP target URL carries the render frame + the page's bridgeId.
// Import the shared reserved doc name rather than hand-writing a second
// literal — that duplication is exactly what let this pattern drift out of
// sync with the actual document URL shape (dmb-resource-url.ts).
const RENDER_GUEST_PATTERN = DMB_PAGEFRAME_DOC_NAME

/**
 * Resolve which CDP target the `simulator` MCP tools should drive.
 *
 * Default (non-native) path: the localhost:7788 simulator shell — identical
 * to the original behavior; `activeBridgeId` is ignored.
 *
 * Native-host path: the active render-host <webview> guest
 * (pageFrame.html?...bridgeId=<id>), preferring the guest matching
 * `activeBridgeId`, then any pageFrame guest, then degrading to the shell.
 */
export function selectSimulatorTarget<T extends { url?: string; type?: string }>(
  targets: T[],
  opts: { nativeHost: boolean; activeBridgeId: string | null },
): T | undefined {
  if (!opts.nativeHost) {
    return targets.find((t) => t.url?.includes(SIMULATOR_URL_PATTERN))
  }

  // 1) Active-bridge guest takes priority over list order.
  if (opts.activeBridgeId !== null) {
    const bridgeMatch = `bridgeId=${opts.activeBridgeId}`
    const active = targets.find(
      (t) => t.url?.includes(RENDER_GUEST_PATTERN) && t.url.includes(bridgeMatch),
    )
    if (active) return active
  }

  // 2) Any render guest (no active match / no active bridge).
  const anyGuest = targets.find((t) => t.url?.includes(RENDER_GUEST_PATTERN))
  if (anyGuest) return anyGuest

  // 3) Degrade to the localhost:7788 shell when no render guest exists yet.
  return targets.find((t) => t.url?.includes(SIMULATOR_URL_PATTERN))
}

/**
 * Resolve which CDP target the `workbench` MCP tools should drive.
 *
 * `projectPath` is the active project window's path, fixed when that window
 * opened; null when no project window is open, and then the project list is
 * the only workbench surface.
 *
 * A project window names its own renderer from the moment it exists, so the
 * match is exact or nothing: another project's workbench page, or the project
 * list standing in for a project that IS open, would leave every workbench
 * tool answering for the wrong window with nothing to correct it.
 *
 * Matching is on the renderer ENTRY, never on "the URL mentions the project
 * directory" — the service-host window carries the same directory in its own
 * `pkgRoot` query and would win a substring match.
 */
export function selectWorkbenchTarget<T extends { url?: string; type?: string }>(
  candidates: T[],
  opts: { projectPath: string | null },
): T | undefined {
  const pages = candidates.filter(
    (t) => t.type === 'page' && !t.url?.includes(SIMULATOR_URL_PATTERN),
  )
  if (opts.projectPath === null) return pages.find((t) => t.url?.includes(PROJECT_LIST_ENTRY))

  return pages.find(
    (t) => t.url?.includes(WORKBENCH_ENTRY) && targetQuery(t.url, 'path') === opts.projectPath,
  )
}
