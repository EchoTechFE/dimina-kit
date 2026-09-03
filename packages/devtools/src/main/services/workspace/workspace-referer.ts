import type { ProjectSession } from '../../../shared/types.js'
import {
  clearSimulatorServicewechatReferer,
  setSimulatorServicewechatReferer,
} from '../simulator/referer.js'

/**
 * The forced `servicewechat.com` Referer is stored per project partition, so
 * every workspace call must name the project it is acting for. Both helpers
 * therefore take the session and project path explicitly: a workspace that
 * reached for its own mutable `currentSession` after resetting it would clear
 * nothing, and one that passed no project at all would be asking to wipe a
 * partition that belongs to whichever project happens to be open elsewhere.
 */

/** Forces this project's Referer. No-op for a session without a usable appId. */
export function applyRefererForSession(session: ProjectSession, projectPath: string): void {
  const appInfo = session.appInfo as { appId?: string; version?: string }
  if (!appInfo || typeof appInfo.appId !== 'string' || appInfo.appId.length === 0) return
  setSimulatorServicewechatReferer(
    appInfo.appId,
    typeof appInfo.version === 'string' ? appInfo.version : undefined,
    projectPath,
  )
}

/**
 * Clears only this project's own entry. Call BEFORE the caller resets its
 * session/path state, otherwise there is no partition left to name.
 */
export function clearRefererForSession(
  session: ProjectSession | null,
  projectPath: string,
): void {
  if (!session) return
  clearSimulatorServicewechatReferer(session.appInfo.appId, projectPath)
}
