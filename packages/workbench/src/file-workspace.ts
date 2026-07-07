/**
 * Mirror the on-disk dimina project into the workbench's default `file://`
 * in-memory filesystem and keep saves flushed back to disk.
 *
 * Why `file://` (not the `diminafs:` provider directly): the web tsserver only
 * treats a `file://` root as a real TS/JS project — it loads jsconfig.json and
 * ambient `.d.ts` files from there. Over a custom scheme it falls back to an
 * inferred project that ignores workspace config + ambient libs, so `dd`
 * resolves to `any`. Mirroring under `file:///workspace/` gives tsserver a real
 * project root; a save listener flushes edits back to disk via the fs bridge so
 * editing stays real (round-trips to the actual project).
 *
 * The disk source is read through the same COI `/__fs/*` bridge the diminafs
 * provider uses, so no extra preload/IPC surface. The bridge calls themselves
 * live in fs-bridge.ts (monaco-free — see that file's header for why).
 */
import { getService, IFileService } from '@codingame/monaco-vscode-api'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { VSBuffer } from '@codingame/monaco-vscode-api/vscode/vs/base/common/buffer'
import { WORKSPACE_FILE_ROOT, bridgeReaddir, bridgeRead, bridgeWrite, relFromWorkspaceUri } from './fs-bridge'
import type { FsEntry } from './fs-bridge'
import { closeStaleWorkspaceEditors, type UriLike } from './stale-editor-sweep'

export {
  WORKSPACE_FILE_ROOT,
  TYPES_ROOT,
  bridgeReaddir,
  bridgeRead,
  bridgeWrite,
  bridgeDelete,
  relFromWorkspaceUri,
} from './fs-bridge'
export type { FsEntry } from './fs-bridge'

/**
 * Recursively copy disk (via the fs bridge) → file:///workspace/ memfs.
 * Returns the number of files mirrored.
 */
export async function mirrorDiskToFileWorkspace(baseUrl: string): Promise<number> {
  const fileService = await getService(IFileService)
  let count = 0

  async function walk(rel: string): Promise<void> {
    const entries = await bridgeReaddir(baseUrl, rel || '.')
    for (const [name, type] of entries) {
      const childRel = rel ? `${rel}/${name}` : name
      if (type === 2) {
        await walk(childRel)
      } else {
        const bytes = await bridgeRead(baseUrl, childRel)
        await fileService.writeFile(URI.parse(`${WORKSPACE_FILE_ROOT}/${childRel}`), VSBuffer.wrap(bytes))
        count++
      }
    }
  }

  // The workbench attaches as soon as the 'editor' dock slot first paints, which
  // can be a beat before the active project is set AND before its compile
  // finishes — until then the COI `/__fs` bridge returns an empty tree (409 → []).
  // Poll the project root until it has entries (project active), THEN mirror once.
  // ~30s budget covers a cold compile; a genuinely empty/no-project workspace
  // simply yields 0 after the wait (no error, no partial copy).
  let rootEntries: FsEntry[] = []
  for (let attempt = 0; attempt < 60; attempt++) {
    rootEntries = await bridgeReaddir(baseUrl, '.')
    if (rootEntries.length > 0) break
    await new Promise((r) => setTimeout(r, 500))
  }
  if (rootEntries.length === 0) return 0
  await walk('')
  return count
}

/**
 * Close restored editor tabs whose files are absent from the populated
 * workspace. Every project shares one persisted editor-state memento (the
 * workspace identity is the constant `file:///workspace`), so after a project
 * switch the restored tabs can point at files the new mirror does not contain
 * — stranding "file was not found" placeholder editors that never self-heal
 * (the placeholder only recovers on a file ADDED event, which never fires for
 * a file this project lacks). Runs after population; failures only log — boot
 * must not die on a state-hygiene step. The sweep decision itself lives in
 * stale-editor-sweep.ts (monaco-free, unit-tested).
 */
export async function sweepStaleRestoredEditors(
  vscodeApi: typeof import('vscode'),
  workspaceRoot: UriLike,
): Promise<void> {
  try {
    const fileService = await getService(IFileService)
    const closed = await closeStaleWorkspaceEditors({
      tabGroups: vscodeApi.window.tabGroups,
      TabInputText: vscodeApi.TabInputText,
      workspaceRoot,
      exists: (uri) => fileService.exists(URI.from({ scheme: uri.scheme, path: uri.path })),
    })
    if (closed > 0) {
      console.info(`[workbench] closed ${closed} restored editor tab(s) whose files are absent from this workspace`)
    }
  } catch (e) {
    console.error('[workbench] stale restored-editor sweep failed', e)
  }
}

/**
 * Flush a file:///workspace/<rel> save back to disk through the fs bridge.
 * `uri` must be under WORKSPACE_FILE_ROOT.
 */
export async function flushFileWorkspaceSaveToDisk(baseUrl: string, uri: URI, content: Uint8Array): Promise<void> {
  const rel = relFromWorkspaceUri(uri)
  if (rel === null) return
  await bridgeWrite(baseUrl, rel, content)
}
