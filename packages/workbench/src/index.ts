/**
 * Public API of `@dimina-kit/workbench` — the dimina VS Code workbench editor,
 * consumed as source by a host's own Vite build.
 *
 * Boot the editor with {@link bootWorkbench}, picking a file source: the
 * disk-backed {@link diskMirrorSource} (devtools) or the {@link inMemorySeedSource}
 * (web). Pair it with {@link workbenchVitePreset} in the host's vite config so
 * the monaco/vscode workers + CSS bundle correctly.
 */
export { bootWorkbench } from './boot'
export type {
  BootWorkbenchOptions,
  WorkbenchHandle,
  WorkbenchFeatures,
  WorkbenchProbe,
} from './boot'

export { buildFileAssociations } from './file-type-associations'
export type { CustomFileTypes } from './file-type-associations'

// File lives at disk-workspace-source.ts: the "mirror a real disk project
// into the editor memfs" DIRECTION is the opposite of fs-core's own
// `disk-mirror` export (OPFS → local directory one-way export), and the two
// must not share a basename. The exported names stay stable.
export { diskMirrorSource } from './workspace/disk-workspace-source'
export type { DiskMirrorOptions } from './workspace/disk-workspace-source'
export { inMemorySeedSource } from './workspace/in-memory-seed'
export type { InMemorySeedOptions } from './workspace/in-memory-seed'
export type { WorkspaceSource } from './workspace/types'

// WAL audit decorator: layers an `@dimina-kit/fs-core` turn/rollback ledger over
// a disk-backed WorkspaceSource. devtools' `src/main.ts` wires this over
// `diskMirrorSource`; exported here for a host to construct/inspect explicitly
// (e.g. a future agent surface driving `audit` directly instead of through the
// `window.__WB_AUDIT` CDP probe).
export { walAuditSource } from './workspace/wal-audit'
export type {
  WalAuditOptions,
  WalAuditSurface,
  WalAuditClientLike,
  WalAuditBridge,
} from './workspace/wal-audit'

export { WORKSPACE_FILE_ROOT } from './file-workspace'
