/** Type declaration for disk-mirror.js (runtime stays plain JS). `fs` is typed
 * loosely for the same reason as in agent-tools.d.ts. */
export declare function createDiskMirror(fs: any): {
  pick(): Promise<{ name: string; written: number; removed: number; gen: number }>
  syncAll(): Promise<{ written: number; removed: number; gen: number } | null>
  schedule(): void
  readonly active: boolean
}
