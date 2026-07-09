/** Type declaration for disk-mirror.js (runtime stays plain JS). `fs` is typed
 * loosely for the same reason as in agent-tools.d.ts. */

/** Structural shape disk-mirror.js actually calls on a directory handle —
 * deliberately looser than the DOM lib's `FileSystemDirectoryHandle` (which
 * also requires `resolve`/`isSameEntry`) so any handle-like object a consumer
 * already holds — a real FSA handle, or a project's own narrower wrapper type
 * — can be injected via `pick(handle)` without a structural mismatch. */
export interface DiskMirrorDirectoryHandle {
  name: string
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DiskMirrorDirectoryHandle>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<{
    createWritable(): Promise<{ write(data: unknown): Promise<void>; close(): Promise<void> }>
  }>
  removeEntry?(name: string, options?: { recursive?: boolean }): Promise<void>
}

export declare function createDiskMirror(fs: any): {
  pick(handle?: DiskMirrorDirectoryHandle): Promise<{ name: string; written: number; removed: number; gen: number }>
  syncAll(): Promise<{ written: number; removed: number; gen: number } | null>
  schedule(): void
  dispose(): void
  readonly active: boolean
}
