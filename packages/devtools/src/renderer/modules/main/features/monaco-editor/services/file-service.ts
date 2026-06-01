/**
 * Renderer-side file access for the Monaco editor.
 *
 * Thin wrappers over the sandboxed `project:fs:*` IPC channels (handled in
 * `src/main/ipc/project-fs.ts`). All paths are absolute and verified
 * against the active project root in the main process. The renderer never
 * touches `node:fs` directly.
 */
import { invoke, invokeStrict, sendSync } from '@/shared/api/ipc-transport'
import { ProjectFsChannel } from '../../../../../../shared/ipc-channels'

/** Result of a synchronous write — `{ ok: false }` carries the sandbox errno. */
export interface SyncWriteResult {
  ok: boolean
  code?: string
  message?: string
}

/** Absolute path of the active project root, or '' when no project is open. */
export function getProjectRoot(): Promise<string> {
  return invoke<string>(ProjectFsChannel.GetRoot)
}

/** Read a file (utf-8). Rejects on escape / missing file. */
export function readProjectFile(absPath: string): Promise<string> {
  return invokeStrict<string>(ProjectFsChannel.ReadFile, absPath)
}

/** Write a file (utf-8), creating parent directories as needed. */
export function writeProjectFile(absPath: string, content: string): Promise<void> {
  return invokeStrict<void>(ProjectFsChannel.WriteFile, absPath, content)
}

/**
 * Synchronous (blocking) write through the SAME sandbox as {@link writeProjectFile}.
 * Use only for the editor's `beforeunload` flush, where the write must land
 * before the renderer is torn down. Returns `{ ok }` instead of throwing so the
 * unload handler never raises mid-teardown.
 */
export function writeProjectFileSync(absPath: string, content: string): SyncWriteResult {
  return sendSync<SyncWriteResult>(ProjectFsChannel.WriteFileSync, absPath, content)
}

/** List all source files under the project root (POSIX-relative paths). */
export function listProjectFiles(rootAbsPath: string): Promise<string[]> {
  return invoke<string[]>(ProjectFsChannel.ListFiles, rootAbsPath)
}
