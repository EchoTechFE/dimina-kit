/**
 * Disk-backed fallback for the embedded workbench's `file://` provider.
 *
 * Why this exists: the editor reads every project file from an in-memory mirror
 * (`file:///workspace`) populated from the COI `/__fs` disk bridge. That mirror
 * is a *cache*, not the source of truth — and a cache can be empty or partial at
 * the exact moment a file is opened (the post-switch re-boot, or the first-
 * compile window). When the cache misses, VS Code's own `openTextDocument` /
 * `showTextDocument` throw FILE_NOT_FOUND and leave a stuck "The editor could
 * not be opened because the file was not found." placeholder — the reported
 * openfile bug.
 *
 * How it works (top-level design): the monaco file service registers an
 * `OverlayFileSystemProvider` for the `file` scheme, with the workspace memfs
 * already mounted at priority 0. `readFromDelegates` in that overlay tries each
 * delegate in priority order and, crucially, *falls through* to the next delegate
 * when one throws a `FileSystemProviderError` with code `FileNotFound`. We mount
 * a disk-reading provider as an **overlay at priority -1** (lower than the memfs,
 * so it is consulted only after the memfs misses). On a memfs read-miss the
 * overlay transparently reads the file from disk over the bridge; a genuinely-
 * missing file still reports not-found (so the user's "Create File" flow stays
 * meaningful); a real-on-disk file always opens, regardless of mirror timing.
 *
 * This is the library-sanctioned entry point (`registerFileSystemOverlay`); the
 * naive alternative of `fileService.registerProvider('file', …)` THROWS because
 * the scheme is already taken by the overlay, and the exception would be
 * swallowed by the caller's try/catch — leaving the fallback silently
 * uninstalled. The overlay's fall-through also requires this provider to surface
 * a genuine disk-miss as a real `FileNotFound` error (never a plain `Error`), or
 * the overlay would treat it as a hard failure instead of continuing.
 *
 * Scope is enforced by {@link relFromWorkspaceUri}: it returns `null` for any
 * URI outside `file:///workspace` (and for the memfs-only injected `node_modules`
 * / `jsconfig` / `tsconfig` artifacts), so those never reach the disk bridge.
 */
import { registerFileSystemOverlay } from '@codingame/monaco-vscode-files-service-override'
import {
  createFileSystemProviderError,
  FileSystemProviderCapabilities,
  FileSystemProviderErrorCode,
  type IFileSystemProviderWithFileReadWriteCapability,
} from '@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files'
import type { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { Event } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'
import { bridgeRead, bridgeReaddir, bridgeStat, relFromWorkspaceUri } from '../fs-bridge'

/** A `FileNotFound` error in the shape the overlay's fall-through logic expects. */
const notFound = (message: string) =>
  createFileSystemProviderError(message, FileSystemProviderErrorCode.FileNotFound)

/**
 * Build a read-only `file://` provider that serves `file:///workspace/*` content
 * from the COI disk bridge (`/__fs/*`). It is mounted as an overlay delegate at
 * priority -1 by {@link installDiskFallbackFileProvider}; the overlay tries the
 * workspace memfs (priority 0) first and only calls this provider when the memfs
 * throws FileNotFound.
 */
export function createDiskProvider(
  fsBaseUrl: string,
): IFileSystemProviderWithFileReadWriteCapability {
  /**
   * Map a disk-bridge miss (the bridge throws `{ status: 404 }`) to a real
   * `FileNotFound`, and pass any other bridge failure through untouched. Returns
   * the error to throw rather than throwing itself, so call sites read
   * `throw asProviderError(…)` and TypeScript sees the control flow end there.
   */
  const asProviderError = (rel: string, e: unknown): unknown =>
    (e as { status?: number } | null)?.status === 404 ? notFound(rel) : e

  const stat = async (resource: URI) => {
    const rel = relFromWorkspaceUri(resource)
    if (rel === null) throw notFound(resource.toString())
    try {
      const st = await bridgeStat(fsBaseUrl, rel)
      return {
        type: st.type === 2 ? 2 : 1,
        ctime: st.mtimeMs ?? Date.now(),
        mtime: st.mtimeMs ?? Date.now(),
        size: st.size ?? 0,
      }
    } catch (e) {
      throw asProviderError(rel, e)
    }
  }

  const readFile = async (resource: URI): Promise<Uint8Array> => {
    const rel = relFromWorkspaceUri(resource)
    if (rel === null) throw notFound(resource.toString())
    try {
      return await bridgeRead(fsBaseUrl, rel)
    } catch (e) {
      throw asProviderError(rel, e)
    }
  }

  const readdir = async (resource: URI): Promise<[string, number][]> => {
    const rel = relFromWorkspaceUri(resource)
    if (rel === null) throw notFound(resource.toString())
    try {
      const entries = await bridgeReaddir(fsBaseUrl, rel)
      return entries.map(([name, type]) => [name, type === 2 ? 2 : 1] as [string, number])
    } catch (e) {
      throw asProviderError(rel, e)
    }
  }

  return {
    capabilities:
      FileSystemProviderCapabilities.FileReadWrite |
      FileSystemProviderCapabilities.PathCaseSensitive |
      FileSystemProviderCapabilities.Readonly,
    onDidChangeCapabilities: Event.None,
    onDidChangeFile: Event.None,

    watch() {
      // Read-only source: nothing to watch. Callers receive a no-op disposable.
      return { dispose() {} }
    },

    stat,
    readFile,
    readdir,

    // Writes are rejected. The `Readonly` capability makes the overlay's
    // `writeToDelegates` skip this provider entirely, so every write lands in
    // the workspace memfs (priority 0) and is flushed to disk by the existing
    // save/sync engine — this provider is purely a read fallback.
    async mkdir() {
      throw createFileSystemProviderError('disk fallback is read-only', FileSystemProviderErrorCode.NoPermissions)
    },
    async writeFile() {
      throw createFileSystemProviderError('disk fallback is read-only', FileSystemProviderErrorCode.NoPermissions)
    },
    async delete() {
      throw createFileSystemProviderError('disk fallback is read-only', FileSystemProviderErrorCode.NoPermissions)
    },
    async rename() {
      throw createFileSystemProviderError('disk fallback is read-only', FileSystemProviderErrorCode.NoPermissions)
    },
  }
}

/**
 * Install the disk fallback for the `file` scheme by mounting a disk-reading
 * provider as an overlay delegate at priority -1 (below the workspace memfs at
 * priority 0). Must run AFTER the monaco file services initialize (so the
 * `file` scheme's `OverlayFileSystemProvider` already exists) and BEFORE any
 * workspace file is read. Returns the disposable that removes the overlay
 * delegate, or throws if the file scheme is no longer an overlay (a setup bug).
 */
export function installDiskFallbackFileProvider(fsBaseUrl: string) {
  return registerFileSystemOverlay(-1, createDiskProvider(fsBaseUrl))
}
