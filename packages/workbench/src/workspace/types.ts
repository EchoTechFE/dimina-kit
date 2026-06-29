/**
 * A workspace file source for the embedded workbench: it owns the single
 * `file://` folder the editor opens, populates it after the services
 * initialize, and (optionally) flushes saves back to wherever the files live.
 *
 * Two built-ins cover the current hosts: {@link diskMirrorSource} (devtools —
 * mirror a real on-disk project over the COI `/__fs` bridge and write saves
 * back to disk) and {@link inMemorySeedSource} (web — seed a fixed file map
 * into an in-memory workspace with no save-back).
 */
import type { IFileService } from '@codingame/monaco-vscode-api'
import type { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'

export interface WorkspaceSource {
  /**
   * The `file://` folder opened as the single workspace root. A `file://` root
   * (not a custom scheme) is what makes the web tsserver treat it as a real
   * project — it loads jsconfig.json + ambient `.d.ts` from there.
   */
  readonly folderUri: string
  /**
   * Populate the workspace memfs after the monaco services initialize. Returns
   * the number of files written.
   */
  populate(fileService: IFileService): Promise<number>
  /**
   * Optional: flush a save under the workspace root back to its origin. Called
   * for every WRITE/CREATE the file service runs; sources with no durable
   * backing (in-memory seed) omit it.
   */
  onSave?(uri: URI, content: Uint8Array): Promise<void>
}
