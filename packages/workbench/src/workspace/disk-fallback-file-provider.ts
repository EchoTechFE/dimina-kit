/**
 * Disk-backed fallback for the embedded workbench's `file://` provider.
 *
 * Why this exists: the editor reads every project file from an in-memory mirror
 * (`file:///workspace`) populated ONCE per workbench boot from the COI `/__fs`
 * disk bridge. That mirror is a *cache*, not the source of truth — and a cache
 * can be empty or partial at the exact moment a file is opened (the post-switch
 * re-boot, or the first-compile window). When the cache misses, VS Code's own
 * `openTextDocument`/`showTextDocument` throw FILE_NOT_FOUND and leave a stuck
 * "The editor could not be opened because the file was not found." placeholder —
 * the reported openfile bug.
 *
 * This wrapper makes disk the single source of truth: it delegates every
 * operation to the wrapped in-memory provider, but on a read-miss for a
 * `file:///workspace/*` URI it fetches the file from disk over the bridge and
 * serves it. A genuinely-missing file still reports not-found (so the user's
 * "Create File" flow stays meaningful); a real-on-disk file always opens,
 * regardless of mirror timing. Non-workspace `file://` reads (VS Code internals)
 * are passed straight through with no fallback.
 *
 * Scope is enforced by {@link relFromWorkspaceUri}: it returns `null` for any
 * URI outside `file:///workspace` (and for the memfs-only injected `@types` /
 * `jsconfig` / `tsconfig` artifacts), so those never reach the disk bridge.
 */
import type { IFileSystemProvider } from '@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files'
import type { IFileService } from '@codingame/monaco-vscode-api'
import type { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import {
  bridgeRead,
  bridgeReaddir,
  bridgeStat,
  relFromWorkspaceUri,
} from '../fs-bridge'

/** A file-system provider whose reads transparently fall back to disk on miss. */
export interface DiskFallbackFileProvider extends IFileSystemProvider {
  /** `true` once this wrapper is installed for the `file` scheme. */
  readonly isDiskFallback: true
}

/**
 * Wrap the existing `file` scheme provider with a disk fallback. Returns the
 * wrapper, or `undefined` when there is no `file` provider to wrap (defensive:
 * boot must have registered one via getFilesServiceOverride).
 */
export function createDiskFallbackFileProvider(
  base: IFileSystemProvider,
  fsBaseUrl: string,
): DiskFallbackFileProvider {
  const fallBack = (e: unknown): boolean => {
    const err = e as { code?: string; fileOperationResult?: number; message?: string }
    if (err?.fileOperationResult === 1) return true // FileOperationResult.FILE_NOT_FOUND
    if (err?.code === 'FileNotFound') return true
    if (/ENOENT|could not be opened|file was not found/i.test(err?.message ?? '')) return true
    return false
  }

  // Only workspace URIs fall back to disk; everything else delegates unchanged.
  const workspaceRel = (uri: URI): string | null => {
    const rel = relFromWorkspaceUri(uri)
    return rel
  }

  const provider = {
    isDiskFallback: true as const,
    capabilities: base.capabilities,
    onDidChangeCapabilities: base.onDidChangeCapabilities,
    onDidChangeFile: base.onDidChangeFile,

    watch(resource: URI, opts: Parameters<IFileSystemProvider['watch']>[1]) {
      return base.watch(resource, opts)
    },

    async stat(resource: URI) {
      try {
        return await base.stat(resource)
      } catch (e) {
        if (!fallBack(e)) throw e
        const rel = workspaceRel(resource)
        if (rel === null) throw e
        const st = await bridgeStat(fsBaseUrl, rel)
        return {
          type: st.type === 2 ? 2 : 1,
          ctime: st.mtimeMs ?? Date.now(),
          mtime: st.mtimeMs ?? Date.now(),
          size: st.size ?? 0,
        }
      }
    },

    mkdir(resource: URI, opts: Parameters<IFileSystemProvider['mkdir']>[1]) {
      return base.mkdir(resource, opts)
    },

    async readdir(resource: URI) {
      try {
        return await base.readdir(resource)
      } catch (e) {
        if (!fallBack(e)) throw e
        const rel = workspaceRel(resource)
        if (rel === null) throw e
        const entries = await bridgeReaddir(fsBaseUrl, rel)
        return entries.map(([name, type]) => [name, type === 2 ? 2 : 1] as [string, number])
      }
    },

    delete(resource: URI, opts: Parameters<IFileSystemProvider['delete']>[1]) {
      return base.delete(resource, opts)
    },

    rename(from: URI, to: URI, opts: Parameters<IFileSystemProvider['rename']>[1]) {
      return base.rename(from, to, opts)
    },

    async readFile(resource: URI) {
      try {
        return await base.readFile(resource)
      } catch (e) {
        if (!fallBack(e)) throw e
        const rel = workspaceRel(resource)
        if (rel === null) throw e
        return bridgeRead(fsBaseUrl, rel)
      }
    },

    writeFile(resource: URI, content: Uint8Array, opts: Parameters<IFileSystemProvider['writeFile']>[1]) {
      return base.writeFile(resource, content, opts)
    },
  } as DiskFallbackFileProvider

  // Forward optional capability methods only when the base actually provides
  // them, so VS Code's capability checks (read-stream / open-read-write) stay
  // accurate and we never advertise an op the base can't service.
  if (typeof (base as { readFileStream?: unknown }).readFileStream === 'function') {
    provider.readFileStream = (resource, opts, token) =>
      (base as Required<IFileSystemProvider>).readFileStream(resource, opts, token)
  }
  if (typeof (base as { open?: unknown }).open === 'function') {
    provider.open = (resource, opts) => (base as Required<IFileSystemProvider>).open(resource, opts)
    provider.close = (fd) => (base as Required<IFileSystemProvider>).close(fd)
    provider.read = (fd, pos, data, offset, length) =>
      (base as Required<IFileSystemProvider>).read(fd, pos, data, offset, length)
    provider.write = (fd, pos, data, offset, length) =>
      (base as Required<IFileSystemProvider>).write(fd, pos, data, offset, length)
  }
  if (typeof (base as { copy?: unknown }).copy === 'function') {
    provider.copy = (from, to, opts) => (base as Required<IFileSystemProvider>).copy(from, to, opts)
  }
  if (typeof (base as { cloneFile?: unknown }).cloneFile === 'function') {
    provider.cloneFile = (from, to) => (base as Required<IFileSystemProvider>).cloneFile(from, to)
  }

  return provider
}

/**
 * Install the disk fallback for the `file` scheme. Must run AFTER the monaco
 * file services initialize (so a `file` provider already exists to wrap) and
 * BEFORE any workspace file is read. Returns the disposable that re-instates
 * the original provider, or `undefined` when there was nothing to wrap.
 */
export async function installDiskFallbackFileProvider(
  fileService: IFileService,
  fsBaseUrl: string,
): Promise<ReturnType<IFileService['registerProvider']> | undefined> {
  const base = fileService.getProvider('file')
  if (!base) return undefined
  const wrapper = createDiskFallbackFileProvider(base, fsBaseUrl)
  return fileService.registerProvider('file', wrapper)
}
