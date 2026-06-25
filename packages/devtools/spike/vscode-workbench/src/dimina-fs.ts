/**
 * `diminafs:` FileSystemProvider — bridges the workbench to a real on-disk
 * dimina project via the COI server's `/__fs/*` endpoints (see coi-server.mjs).
 *
 * Registered through `registerCustomProvider('diminafs', …)` from the
 * files-service-override; the workspace opens `diminafs:/` as its single folder
 * so the Explorer renders the real project tree and edits write back to disk.
 *
 * Capabilities: FileReadWrite (read/write whole files) — enough for Explorer
 * browse + open + save. Watch is a no-op (the spike doesn't need live external
 * change notifications).
 */
import {
  FileType,
  FileSystemProviderCapabilities,
  FileSystemProviderError,
  FileSystemProviderErrorCode,
  type IFileSystemProviderWithFileReadWriteCapability,
  type IStat,
  type IWatchOptions,
  type IFileWriteOptions,
  type IFileDeleteOptions,
  type IFileOverwriteOptions,
  type IFileChange,
} from '@codingame/monaco-vscode-files-service-override'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { Emitter, type Event } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'
import { Disposable, type IDisposable } from '@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle'

function relOf(resource: URI): string {
  // diminafs:/pages/index.wxml → pages/index.wxml
  return resource.path.replace(/^\/+/, '')
}

export class DiminaFileSystemProvider
  extends Disposable
  implements IFileSystemProviderWithFileReadWriteCapability
{
  readonly capabilities =
    FileSystemProviderCapabilities.FileReadWrite |
    FileSystemProviderCapabilities.PathCaseSensitive

  private readonly _onDidChangeCapabilities = this._register(new Emitter<void>())
  readonly onDidChangeCapabilities: Event<void> = this._onDidChangeCapabilities.event

  private readonly _onDidChangeFile = this._register(new Emitter<readonly IFileChange[]>())
  readonly onDidChangeFile: Event<readonly IFileChange[]> = this._onDidChangeFile.event

  constructor(private readonly baseUrl: string) {
    super()
  }

  private endpoint(action: string, resource: URI, extra?: Record<string, string>): string {
    const u = new URL(`${this.baseUrl}__fs/${action}`)
    u.searchParams.set('p', relOf(resource))
    if (extra) for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v)
    return u.toString()
  }

  private static toFsError(status: number, message: string): FileSystemProviderError {
    const code =
      status === 404 ? FileSystemProviderErrorCode.FileNotFound : FileSystemProviderErrorCode.Unknown
    return new FileSystemProviderError(message, code)
  }

  async stat(resource: URI): Promise<IStat> {
    const res = await fetch(this.endpoint('stat', resource))
    if (!res.ok) throw DiminaFileSystemProvider.toFsError(res.status, `stat ${resource.path}`)
    const j = (await res.json()) as { type: number; size: number; ctime: number; mtime: number }
    return {
      type: j.type === 2 ? FileType.Directory : FileType.File,
      ctime: j.ctime,
      mtime: j.mtime,
      size: j.size,
    }
  }

  async readdir(resource: URI): Promise<[string, FileType][]> {
    const res = await fetch(this.endpoint('readdir', resource))
    if (!res.ok) throw DiminaFileSystemProvider.toFsError(res.status, `readdir ${resource.path}`)
    const entries = (await res.json()) as [string, number][]
    return entries.map(([name, t]) => [name, t === 2 ? FileType.Directory : FileType.File])
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    const res = await fetch(this.endpoint('read', resource))
    if (!res.ok) throw DiminaFileSystemProvider.toFsError(res.status, `read ${resource.path}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  async writeFile(resource: URI, content: Uint8Array, _opts: IFileWriteOptions): Promise<void> {
    const res = await fetch(this.endpoint('write', resource), {
      method: 'POST',
      // Copy into a fresh ArrayBuffer so the body is a tight view, not the
      // backing buffer of a possibly-larger pooled allocation.
      body: content.slice(),
    })
    if (!res.ok) throw DiminaFileSystemProvider.toFsError(res.status, `write ${resource.path}`)
    this._onDidChangeFile.fire([{ type: 0 /* UPDATED */, resource } as unknown as IFileChange])
  }

  async mkdir(resource: URI): Promise<void> {
    const res = await fetch(this.endpoint('mkdir', resource), { method: 'POST' })
    if (!res.ok) throw DiminaFileSystemProvider.toFsError(res.status, `mkdir ${resource.path}`)
  }

  async delete(resource: URI, _opts: IFileDeleteOptions): Promise<void> {
    const res = await fetch(this.endpoint('delete', resource), { method: 'POST' })
    if (!res.ok) throw DiminaFileSystemProvider.toFsError(res.status, `delete ${resource.path}`)
  }

  async rename(from: URI, to: URI, _opts: IFileOverwriteOptions): Promise<void> {
    const res = await fetch(this.endpoint('rename', from, { to: relOf(to) }), { method: 'POST' })
    if (!res.ok) throw DiminaFileSystemProvider.toFsError(res.status, `rename ${from.path}`)
  }

  watch(_resource: URI, _opts: IWatchOptions): IDisposable {
    return Disposable.None
  }
}
