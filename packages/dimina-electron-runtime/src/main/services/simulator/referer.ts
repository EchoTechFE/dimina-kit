/**
 * WeChat-style page-frame referer for HTTPS requests proxied from the runtime session.
 * Format: https://servicewechat.com/{appId}/{version}/page-frame.html
 *
 * Scoped per session PARTITION (see ../views/miniapp-partition.ts), not
 * globally: each open project runs on its own `persist:miniapp-<key>`
 * partition, so its forced Referer must not leak onto — or be wiped by —
 * another project that happens to be open at the same time in a different
 * BrowserWindow.
 */

import { miniappPartition } from '../views/miniapp-partition.js'

const DEFAULT_VERSION = 'develop'

/** One entry per project partition; see the module doc for why this can't be
 * a single value. */
const refererByPartition = new Map<string, string>()

export function buildServicewechatPageFrameReferer(
  appId: string,
  version: string = DEFAULT_VERSION,
): string {
  return `https://servicewechat.com/${appId}/${version}/page-frame.html`
}

/**
 * Called when a project session is active so protocol.handle can force
 * Referer on THAT project's partition only. `projectPath` mirrors the
 * project-identity fold `miniappPartition` already applies elsewhere (two
 * different projects can declare the same appId); omitting it targets the
 * legacy appId-only partition.
 */
export function setSimulatorServicewechatReferer(
  appId: string,
  version?: string,
  projectPath?: string | null,
): void {
  const partition = miniappPartition(appId, projectPath)
  refererByPartition.set(
    partition,
    buildServicewechatPageFrameReferer(
      appId,
      version && version.length > 0 ? version : DEFAULT_VERSION,
    ),
  )
}

/**
 * Clears only the calling project's own entry. Without an `appId` there is no
 * partition to target, so this is a deliberate no-op rather than a global
 * wipe — a caller that reaches this before it ever learned an appId (e.g. a
 * compile that failed before appInfo resolved) must not strip the Referer off
 * every other project that is still open.
 */
export function clearSimulatorServicewechatReferer(
  appId?: string,
  projectPath?: string | null,
): void {
  if (!appId) return
  refererByPartition.delete(miniappPartition(appId, projectPath))
}

export function getSimulatorServicewechatReferer(partition: string): string | null {
  return refererByPartition.get(partition) ?? null
}
