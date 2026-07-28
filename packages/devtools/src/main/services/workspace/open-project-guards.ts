import { z } from 'zod'
import type { ProjectSession } from '../../../shared/types.js'
import type { ProjectsProvider } from '../projects/types.js'

/**
 * Run the provider's project-dir validation, folding a throwing/rejecting
 * validator into the same dirError failure path as a returned error string —
 * a broken validator is a failed validation, not a crashed open.
 */
export async function validateProjectDirSafe(
  provider: ProjectsProvider,
  projectPath: string,
): Promise<string | null> {
  try {
    return provider.validateProjectDir
      ? await provider.validateProjectDir(projectPath)
      : null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/**
 * Runtime guard for the adapter-return boundary: `session.appInfo` must carry a
 * NON-EMPTY string `appId` (the renderer scopes IPC by it; the bridge's
 * handleSpawn also rejects empty appIds, so accepting `''` would desync layers).
 * Loose: extra fields pass through — only the contract-critical `appId` is enforced.
 */
const SessionAppInfoSchema = z.looseObject({ appId: z.string().min(1) })

/**
 * Adapter-return boundary: a session without a string appId can't be driven by
 * the renderer, so it must never become active. Close the live resources the
 * adapter already spun up (best-effort) and return the error message; null when
 * valid.
 */
export async function rejectInvalidAppId(session: ProjectSession): Promise<string | null> {
  if (SessionAppInfoSchema.safeParse(session.appInfo).success) return null
  try {
    await session.close()
  } catch (closeErr) {
    console.warn('[workspace] closing appId-less adapter session failed (non-fatal):', closeErr)
  }
  return 'adapter returned session.appInfo without a string appId — '
    + 'the CompilationAdapter must supply appInfo.appId'
}
